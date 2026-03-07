'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED_FIELDS = ['type', 'severity', 'nodeId', 'timestamp'];
const VALID_SEVERITIES = ['info', 'warning', 'error', 'critical'];
const SECRET_PATTERNS = [
  /(?:password|secret|token|key|api_key|apikey|auth)\s*[:=]\s*["']?([^"'\s]+)/gi,
  /(?:Bearer\s+)([A-Za-z0-9._-]+)/g
];
const MAX_PAYLOAD_SIZE = 65536; // 64KB

function createEventStore(opts = {}) {
  const events = [];
  const subscribers = new Set();
  const dataDir = opts.dataDir || null;
  const maxPayloadSize = opts.maxPayloadSize || MAX_PAYLOAD_SIZE;
  const maxInMemory = opts.maxInMemory || 500000;

  // Serialized write queue to prevent JSONL corruption under concurrent writes
  const writeQueue = [];
  let writing = false;

  function drainWriteQueue() {
    if (writing || writeQueue.length === 0) return;
    writing = true;
    const { filePath, line } = writeQueue.shift();
    fs.appendFile(filePath, line, () => {
      writing = false;
      drainWriteQueue();
    });
  }

  function enqueueWrite(filePath, line) {
    writeQueue.push({ filePath, line });
    drainWriteQueue();
  }

  function redactSecrets(payload) {
    if (typeof payload !== 'string') payload = JSON.stringify(payload);
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      payload = payload.replace(pattern, (match, group) => {
        return match.replace(group, '***REDACTED***');
      });
    }
    return payload;
  }

  function ingest(event) {
    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (!event[field]) throw new Error(`Missing required field: ${field}`);
    }
    if (!VALID_SEVERITIES.includes(event.severity)) {
      throw new Error(`Invalid severity: ${event.severity}`);
    }
    // Check payload size
    const payloadStr = JSON.stringify(event);
    if (Buffer.byteLength(payloadStr) > maxPayloadSize) {
      throw new Error('Payload exceeds size limit');
    }
    // Redact secrets in payload
    const stored = { ...event };
    stored.id = stored.id || crypto.randomUUID();
    if (stored.payload) {
      stored.payload = redactSecrets(stored.payload);
    }
    stored.receivedAt = Date.now();
    events.push(stored);

    // Evict oldest in-memory events when cap is exceeded (persisted events remain on disk)
    while (events.length > maxInMemory) {
      events.shift();
    }

    // Notify subscribers
    for (const cb of subscribers) {
      try { cb(stored); } catch {}
    }

    // Persist to JSONL via serialized write queue
    if (dataDir) {
      const dateStr = new Date(stored.receivedAt).toISOString().split('T')[0];
      const filePath = path.join(dataDir, `events-${dateStr}.jsonl`);
      enqueueWrite(filePath, JSON.stringify(stored) + '\n');
    }

    return stored;
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function query(filters = {}) {
    let result = [...events];
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() >= start);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() <= end);
    }
    if (filters.type) {
      result = result.filter(e => e.type === filters.type);
    }
    if (filters.severity) {
      result = result.filter(e => e.severity === filters.severity);
    }
    if (filters.nodeId) {
      result = result.filter(e => e.nodeId === filters.nodeId);
    }
    return result;
  }

  function getAll() { return [...events]; }

  return { ingest, subscribe, query, getAll, redactSecrets };
}

module.exports = { createEventStore, REQUIRED_FIELDS, VALID_SEVERITIES };
