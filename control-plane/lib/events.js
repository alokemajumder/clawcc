'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED_FIELDS = ['type', 'severity', 'nodeId', 'timestamp'];
const VALID_SEVERITIES = ['info', 'warning', 'error', 'critical'];
const SECRET_KEY_NAMES = new Set([
  'password', 'secret', 'token', 'key', 'apikey', 'api_key',
  'apikey', 'auth', 'authorization', 'credential', 'private_key',
  'privatekey', 'access_token', 'refresh_token', 'session_token'
]);
const BEARER_PATTERN = /(?:Bearer\s+)([A-Za-z0-9._-]+)/g;
const MAX_PAYLOAD_SIZE = 65536; // 64KB

function createEventStore(opts = {}) {
  const events = [];
  const subscribers = new Set();
  const dataDir = opts.dataDir || null;
  const maxPayloadSize = opts.maxPayloadSize || MAX_PAYLOAD_SIZE;
  const maxInMemory = opts.maxInMemory || 500000;

  // Serialized write queue to prevent JSONL corruption under concurrent writes
  const writeQueue = [];
  const maxWriteQueue = opts.maxWriteQueue || 10000;
  let writing = false;

  let droppedWrites = 0;

  function drainWriteQueue() {
    if (writing || writeQueue.length === 0) return;
    writing = true;
    const { filePath, line } = writeQueue.shift();
    fs.appendFile(filePath, line, (err) => {
      if (err) console.error('Event write error:', err.message, 'file:', filePath);
      writing = false;
      drainWriteQueue();
    });
  }

  function enqueueWrite(filePath, line) {
    if (writeQueue.length >= maxWriteQueue) {
      droppedWrites++;
      if (droppedWrites % 100 === 1) {
        console.error('[BACKPRESSURE] Event write queue full (' + maxWriteQueue + '), dropped ' + droppedWrites + ' writes total');
      }
      return;
    }
    writeQueue.push({ filePath, line });
    drainWriteQueue();
  }

  function getWriteQueueStats() {
    return { queued: writeQueue.length, dropped: droppedWrites, writing };
  }

  function redactSecrets(payload) {
    if (payload == null) return payload;
    if (typeof payload === 'string') {
      // Redact Bearer tokens in string values
      BEARER_PATTERN.lastIndex = 0;
      return payload.replace(BEARER_PATTERN, (match, group) => match.replace(group, '***REDACTED***'));
    }
    if (typeof payload !== 'object') return payload;
    // Deep-clone and redact object payloads by key name
    if (Array.isArray(payload)) return payload.map(item => redactSecrets(item));
    const redacted = {};
    for (const [k, v] of Object.entries(payload)) {
      if (SECRET_KEY_NAMES.has(k.toLowerCase())) {
        redacted[k] = '***REDACTED***';
      } else if (typeof v === 'string') {
        BEARER_PATTERN.lastIndex = 0;
        redacted[k] = v.replace(BEARER_PATTERN, (match, group) => match.replace(group, '***REDACTED***'));
      } else if (typeof v === 'object' && v !== null) {
        redacted[k] = redactSecrets(v);
      } else {
        redacted[k] = v;
      }
    }
    return redacted;
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

  return { ingest, subscribe, query, getAll, redactSecrets, getWriteQueueStats };
}

module.exports = { createEventStore, REQUIRED_FIELDS, VALID_SEVERITIES };
