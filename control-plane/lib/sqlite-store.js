'use strict';

const fs = require('fs');
const path = require('path');

/**
 * SQLite Acceleration Layer
 *
 * Optional acceleration layer over the append-only JSONL event store.
 * JSONL remains the tamper-evident source of truth for compliance.
 * SQLite provides fast compound queries, aggregation, and range scans.
 *
 * Uses node:sqlite (DatabaseSync) — available in Node.js 22+.
 * Falls back gracefully: if node:sqlite is unavailable, createSqliteStore() returns null
 * and the system operates purely on the in-memory index + JSONL.
 */

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  // node:sqlite not available — module will return null from createSqliteStore
}

const SCHEMA_VERSION = 1;

function createSqliteStore(opts = {}) {
  if (!DatabaseSync) return null;

  const dbPath = opts.path || ':memory:';
  const walMode = opts.walMode !== false;

  // Ensure parent directory exists for file-based DBs
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    console.warn('[SQLite] Failed to open database:', err.message);
    return null;
  }

  // Performance pragmas
  if (walMode) {
    try { db.exec('PRAGMA journal_mode=WAL'); } catch { /* ignore */ }
  }
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA cache_size=-8000');  // 8MB cache
  db.exec('PRAGMA temp_store=MEMORY');

  // --- Schema ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      node_id TEXT,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      date TEXT NOT NULL,
      payload TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_counts (
      date TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      entry_id TEXT PRIMARY KEY,
      seq INTEGER,
      ts TEXT NOT NULL,
      actor TEXT,
      action TEXT,
      target TEXT,
      detail TEXT,
      hash TEXT,
      previous_hash TEXT,
      date TEXT NOT NULL
    )
  `);

  // Compound indexes for common query patterns
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_node_type ON events(node_id, type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_entries(timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_received ON usage_entries(received_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_entries(date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_entries(action)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_entries(actor)');

  // Set schema version
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)');
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');

  const currentVersion = getMeta.get('schema_version');
  if (!currentVersion) {
    setMeta.run('schema_version', String(SCHEMA_VERSION));
  }

  // --- Prepared statements ---
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events(id, type, severity, node_id, session_id, timestamp, received_at, date, payload)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDailyCount = db.prepare(`
    INSERT INTO daily_counts(date, count) VALUES(?, 1)
    ON CONFLICT(date) DO UPDATE SET count = count + 1
  `);

  const insertUsage = db.prepare(`
    INSERT INTO usage_entries(timestamp, provider, model, cost, input_tokens, output_tokens, received_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAudit = db.prepare(`
    INSERT OR IGNORE INTO audit_entries(entry_id, seq, ts, actor, action, target, detail, hash, previous_hash, date)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const maxReceivedAt = db.prepare('SELECT COALESCE(MAX(received_at), 0) as max_ts FROM events');

  // --- Public API ---

  /**
   * Index a single event into SQLite (called alongside in-memory indexEvent)
   */
  function indexEvent(event) {
    const id = event.id || event.entryId || '';
    const ts = event.ts || event.timestamp || '';
    const date = ts.slice(0, 10);
    const receivedAt = event.receivedAt || Date.now();
    const payload = event.payload ? JSON.stringify(event.payload) : null;

    try {
      insertEvent.run(id, event.type || '', event.severity || '', event.nodeId || null,
        event.sessionId || null, ts, receivedAt, date, payload);
      upsertDailyCount.run(date);

      // Also insert into usage table if it's a provider.usage event
      if (event.type === 'provider.usage' && event.payload) {
        const p = event.payload;
        insertUsage.run(ts, p.provider || 'unknown', p.model || 'unknown',
          p.cost || 0, p.inputTokens || 0, p.outputTokens || 0, receivedAt);
      }
    } catch { /* ignore duplicates or errors */ }
  }

  /**
   * Index an audit entry into SQLite
   */
  function indexAuditEntry(entry) {
    try {
      insertAudit.run(
        entry.entryId || '', entry.seq || 0, entry.ts || '',
        entry.actor || '', entry.action || '', entry.target || null,
        entry.detail || null, entry.hash || null, entry.previousHash || null,
        (entry.ts || '').slice(0, 10)
      );
    } catch { /* ignore duplicates */ }
  }

  /**
   * Query events with compound filters.
   * Returns newest-first, respects limit/offset.
   */
  function queryEvents(filters) {
    filters = filters || {};
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const clauses = [];
    const params = [];

    if (filters.sessionId) { clauses.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.nodeId) { clauses.push('node_id = ?'); params.push(filters.nodeId); }
    if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
    if (filters.severity) { clauses.push('severity = ?'); params.push(filters.severity); }
    if (filters.from) { clauses.push('date >= ?'); params.push(filters.from); }
    if (filters.to) { clauses.push('date <= ?'); params.push(filters.to); }

    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
    const sql = `SELECT id, type, severity, node_id, session_id, timestamp, received_at, date, payload
                 FROM events ${where}
                 ORDER BY received_at DESC
                 LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      const rows = db.prepare(sql).all(...params);
      return rows.map(rowToEvent);
    } catch (err) {
      console.warn('[SQLite] queryEvents error:', err.message);
      return null; // caller falls back to in-memory
    }
  }

  /**
   * Get heatmap data from pre-aggregated daily_counts table (O(days))
   */
  function getHeatmap(days) {
    days = days || 30;
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().slice(0, 10);

    try {
      const rows = db.prepare('SELECT date, count FROM daily_counts WHERE date >= ? ORDER BY date').all(cutoff);
      const heatmap = {};
      let max = 0;

      // Fill in all days (including zeros)
      for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        heatmap[dateStr] = 0;
      }

      for (const row of rows) {
        heatmap[row.date] = row.count;
        if (row.count > max) max = row.count;
      }

      return { heatmap, max };
    } catch {
      return null; // fallback to in-memory
    }
  }

  /**
   * Rolling usage aggregation from the usage_entries table
   */
  function getRollingUsage(windowMs) {
    const cutoffMs = Date.now() - windowMs;

    try {
      const rows = db.prepare(`
        SELECT provider, model, COUNT(*) as requests,
               SUM(cost) as total_cost,
               SUM(input_tokens) as total_input,
               SUM(output_tokens) as total_output
        FROM usage_entries
        WHERE received_at >= ?
        GROUP BY provider, model
      `).all(cutoffMs);

      const providers = {};
      let totalRequests = 0, totalTokens = 0, totalCost = 0;

      for (const row of rows) {
        if (!providers[row.provider]) {
          providers[row.provider] = { models: {}, totalCost: 0, totalRequests: 0 };
        }
        const prov = providers[row.provider];
        prov.models[row.model] = {
          requests: row.requests,
          inputTokens: row.total_input,
          outputTokens: row.total_output,
          cost: row.total_cost
        };
        prov.totalCost += row.total_cost;
        prov.totalRequests += row.requests;
        totalRequests += row.requests;
        totalTokens += row.total_input + row.total_output;
        totalCost += row.total_cost;
      }

      return { providers, totals: { requests: totalRequests, tokens: totalTokens, cost: totalCost } };
    } catch {
      return null; // fallback to in-memory
    }
  }

  /**
   * Query audit entries using SQLite instead of JSONL file scan
   */
  function queryAudit(filters) {
    filters = filters || {};
    const limit = Math.min(filters.limit || 100, 10000);

    const clauses = [];
    const params = [];

    if (filters.actor) { clauses.push('actor = ?'); params.push(filters.actor); }
    if (filters.action) { clauses.push('action = ?'); params.push(filters.action); }
    if (filters.target) { clauses.push('target = ?'); params.push(filters.target); }
    if (filters.from) { clauses.push('date >= ?'); params.push(filters.from); }
    if (filters.to) { clauses.push('date <= ?'); params.push(filters.to); }

    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
    const sql = `SELECT * FROM audit_entries ${where} ORDER BY ts DESC LIMIT ?`;
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params);
      return rows.map(row => ({
        entryId: row.entry_id,
        seq: row.seq,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: row.detail,
        hash: row.hash,
        previousHash: row.previous_hash
      }));
    } catch {
      return null; // fallback to JSONL scan
    }
  }

  /**
   * Get the max received_at timestamp in the events table.
   * Used for incremental catch-up: only scan JSONL lines newer than this.
   */
  function getMaxReceivedAt() {
    try {
      const row = maxReceivedAt.get();
      return row ? row.max_ts : 0;
    } catch { return 0; }
  }

  /**
   * Catch up from JSONL files — only process events newer than what's already in SQLite.
   * On first boot (empty DB), this does a full rebuild.
   */
  function catchUpFromJSONL(dataDir) {
    const eventsDir = path.join(dataDir, 'events');
    const maxTs = getMaxReceivedAt();
    let indexed = 0;

    try {
      const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl')).sort();

      // Use a transaction for bulk inserts (much faster)
      db.exec('BEGIN');
      try {
        for (const file of files) {
          const content = fs.readFileSync(path.join(eventsDir, file), 'utf8').trim();
          if (!content) continue;
          for (const line of content.split('\n')) {
            try {
              const event = JSON.parse(line);
              // Skip events already in SQLite
              if (event.receivedAt && event.receivedAt <= maxTs) continue;
              indexEvent(event);
              indexed++;
            } catch { /* skip bad lines */ }
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      if (err.message && !err.message.includes('ENOENT')) {
        console.warn('[SQLite] JSONL catch-up error:', err.message);
      }
    }

    return indexed;
  }

  /**
   * Catch up audit logs from JSONL files
   */
  function catchUpAuditFromJSONL(dataDir) {
    const auditDir = path.join(dataDir, 'audit');
    let indexed = 0;

    try {
      const files = fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl')).sort();

      db.exec('BEGIN');
      try {
        for (const file of files) {
          const content = fs.readFileSync(path.join(auditDir, file), 'utf8').trim();
          if (!content) continue;
          for (const line of content.split('\n')) {
            try {
              const entry = JSON.parse(line);
              indexAuditEntry(entry);
              indexed++;
            } catch { /* skip bad lines */ }
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      if (err.message && !err.message.includes('ENOENT')) {
        console.warn('[SQLite] Audit catch-up error:', err.message);
      }
    }

    return indexed;
  }

  /**
   * Get event count for stats
   */
  function eventCount() {
    try {
      return db.prepare('SELECT COUNT(*) as cnt FROM events').get().cnt;
    } catch { return 0; }
  }

  /**
   * Close the database connection (called during graceful shutdown)
   */
  function close() {
    try { db.close(); } catch { /* ignore */ }
  }

  // --- Helpers ---

  function rowToEvent(row) {
    const event = {
      id: row.id,
      type: row.type,
      severity: row.severity,
      nodeId: row.node_id,
      sessionId: row.session_id,
      ts: row.timestamp,
      timestamp: row.timestamp,
      receivedAt: row.received_at,
      date: row.date
    };
    if (row.payload) {
      try { event.payload = JSON.parse(row.payload); } catch { event.payload = null; }
    }
    return event;
  }

  return {
    indexEvent,
    indexAuditEntry,
    queryEvents,
    getHeatmap,
    getRollingUsage,
    queryAudit,
    getMaxReceivedAt,
    catchUpFromJSONL,
    catchUpAuditFromJSONL,
    eventCount,
    close
  };
}

module.exports = { createSqliteStore };
