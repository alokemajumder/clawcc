'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let lastHash = '0'.repeat(64);
let seq = 0;
const ensuredDirs = new Set();
let _sqliteStore = null;

function setSqliteStore(store) {
  _sqliteStore = store;
}

function init(dataDir) {
  const auditDir = path.join(dataDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const todayFile = path.join(auditDir, today + '.jsonl');
  try {
    const content = fs.readFileSync(todayFile, 'utf8').trim();
    if (content) {
      const lines = content.split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      lastHash = last.hash || lastHash;
      seq = (last.seq || 0) + 1;
    }
  } catch { /* fresh start */ }
}

function log(entry) {
  const auditDir = entry._auditDir || path.join(process.cwd(), 'data', 'audit');
  if (!ensuredDirs.has(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
    ensuredDirs.add(auditDir);
  }

  const record = {
    ts: new Date().toISOString(),
    entryId: crypto.randomUUID(),
    seq: seq++,
    actor: entry.actor || 'system',
    action: entry.action || 'unknown',
    target: entry.target || null,
    detail: entry.detail || null,
    beforeHash: entry.beforeHash || null,
    afterHash: entry.afterHash || null,
    approvalChain: entry.approvalChain || null,
    reason: entry.reason || null,
    previousHash: lastHash
  };

  record.hash = crypto.createHash('sha256')
    .update(JSON.stringify({ ...record, hash: undefined }))
    .digest('hex');
  lastHash = record.hash;

  const date = record.ts.slice(0, 10);
  const filePath = path.join(auditDir, date + '.jsonl');
  delete record._auditDir;
  fs.appendFile(filePath, JSON.stringify(record) + '\n', { flag: 'a' }, (err) => {
    if (err) console.error('Audit write error:', err.message);
  });

  // Mirror to SQLite if available
  if (_sqliteStore) {
    try { _sqliteStore.indexAuditEntry(record); } catch { /* ignore */ }
  }

  return record;
}

function rotate(dataDir, retentionDays) {
  retentionDays = retentionDays || 90;
  const auditDir = path.join(dataDir, 'audit');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let removed = 0;
  try {
    const files = fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      if (file.replace('.jsonl', '') < cutoffStr) {
        fs.unlinkSync(path.join(auditDir, file));
        removed++;
      }
    }
  } catch { /* ignore */ }

  return { removed };
}

function query(dataDir, filters) {
  filters = filters || {};
  const limit = Math.min(filters.limit || 100, 10000);

  // Try SQLite first for faster queries
  if (_sqliteStore) {
    const result = _sqliteStore.queryAudit({ ...filters, limit });
    if (result) return result;
  }

  // Fallback: scan JSONL files
  const auditDir = path.join(dataDir, 'audit');
  const entries = [];

  try {
    const files = fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl')).sort().reverse();

    for (const file of files) {
      const date = file.replace('.jsonl', '');
      if (filters.from && date < filters.from) continue;
      if (filters.to && date > filters.to) continue;

      const content = fs.readFileSync(path.join(auditDir, file), 'utf8').trim();
      if (!content) continue;

      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (filters.actor && entry.actor !== filters.actor) continue;
          if (filters.action && entry.action !== filters.action) continue;
          if (filters.target && entry.target !== filters.target) continue;
          entries.push(entry);
          if (entries.length >= limit) return entries;
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* ignore */ }

  return entries;
}

function exportAudit(dataDir, from, to) {
  const entries = query(dataDir, { from, to, limit: 10000 });
  const firstHash = entries.length > 0 ? entries[entries.length - 1].hash : null;
  const lastHashVal = entries.length > 0 ? entries[0].hash : null;
  return { entries, integrity: { firstHash, lastHash: lastHashVal, count: entries.length } };
}

module.exports = { init, log, rotate, query, export: exportAudit, setSqliteStore };
