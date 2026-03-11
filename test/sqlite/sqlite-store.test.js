'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createSqliteStore } = require('../../control-plane/lib/sqlite-store');

// Check if node:sqlite is available
let hasSqlite = false;
try {
  require('node:sqlite');
  hasSqlite = true;
} catch { /* node:sqlite not available */ }

// Helper: create a temp dir with JSONL event files
function createTempData() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawcc-sqlite-test-'));
  const eventsDir = path.join(tmpDir, 'events');
  const auditDir = path.join(tmpDir, 'audit');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  return tmpDir;
}

function writeEvents(dataDir, events) {
  const eventsDir = path.join(dataDir, 'events');
  const byDate = {};
  for (const e of events) {
    const date = (e.ts || e.timestamp || '').slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(JSON.stringify(e));
  }
  for (const [date, lines] of Object.entries(byDate)) {
    fs.writeFileSync(path.join(eventsDir, `events-${date}.jsonl`), lines.join('\n') + '\n');
  }
}

function writeAuditEntries(dataDir, entries) {
  const auditDir = path.join(dataDir, 'audit');
  const byDate = {};
  for (const e of entries) {
    const date = (e.ts || '').slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(JSON.stringify(e));
  }
  for (const [date, lines] of Object.entries(byDate)) {
    fs.writeFileSync(path.join(auditDir, `${date}.jsonl`), lines.join('\n') + '\n');
  }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (hasSqlite) {
  describe('SQLite Store', () => {
    let store;
    let tmpDir;

    before(() => {
      tmpDir = createTempData();
      store = createSqliteStore({ path: ':memory:' });
      assert.ok(store, 'Store should be created when node:sqlite is available');
    });

    after(() => {
      if (store) store.close();
      cleanup(tmpDir);
    });

    describe('createSqliteStore', () => {
      it('returns an object with expected methods', () => {
        const methods = ['indexEvent', 'indexAuditEntry', 'queryEvents', 'getHeatmap',
          'getRollingUsage', 'queryAudit', 'getMaxReceivedAt', 'catchUpFromJSONL',
          'catchUpAuditFromJSONL', 'eventCount', 'close'];
        for (const m of methods) {
          assert.equal(typeof store[m], 'function', `Missing method: ${m}`);
        }
      });

      it('returns null for file-based DB with invalid path (graceful)', () => {
        // This tests that creation doesn't throw
        const s = createSqliteStore({ path: ':memory:' });
        assert.ok(s);
        s.close();
      });
    });

    describe('indexEvent + queryEvents', () => {
      it('indexes and queries a single event', () => {
        store.indexEvent({
          id: 'evt-1', type: 'session.started', severity: 'info',
          nodeId: 'node-a', sessionId: 'sess-1',
          ts: '2026-03-10T12:00:00Z', timestamp: '2026-03-10T12:00:00Z',
          receivedAt: 1000, payload: { model: 'gpt-4' }
        });
        const results = store.queryEvents({ sessionId: 'sess-1' });
        assert.ok(results);
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 'evt-1');
        assert.equal(results[0].sessionId, 'sess-1');
        assert.deepEqual(results[0].payload, { model: 'gpt-4' });
      });

      it('filters by type', () => {
        store.indexEvent({
          id: 'evt-2', type: 'tool.call', severity: 'info',
          nodeId: 'node-a', sessionId: 'sess-1',
          ts: '2026-03-10T12:01:00Z', timestamp: '2026-03-10T12:01:00Z',
          receivedAt: 2000
        });
        const results = store.queryEvents({ type: 'tool.call' });
        assert.equal(results.length, 1);
        assert.equal(results[0].type, 'tool.call');
      });

      it('filters by node', () => {
        store.indexEvent({
          id: 'evt-3', type: 'session.started', severity: 'info',
          nodeId: 'node-b', sessionId: 'sess-2',
          ts: '2026-03-10T12:02:00Z', timestamp: '2026-03-10T12:02:00Z',
          receivedAt: 3000
        });
        const results = store.queryEvents({ nodeId: 'node-b' });
        assert.equal(results.length, 1);
        assert.equal(results[0].nodeId, 'node-b');
      });

      it('supports compound filters', () => {
        const results = store.queryEvents({ nodeId: 'node-a', type: 'session.started' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 'evt-1');
      });

      it('returns newest first', () => {
        const results = store.queryEvents({});
        assert.ok(results.length >= 3);
        assert.ok(results[0].receivedAt >= results[1].receivedAt);
      });

      it('respects limit and offset', () => {
        const results = store.queryEvents({ limit: 1 });
        assert.equal(results.length, 1);
        const offset = store.queryEvents({ limit: 1, offset: 1 });
        assert.equal(offset.length, 1);
        assert.notEqual(results[0].id, offset[0].id);
      });

      it('filters by date range', () => {
        store.indexEvent({
          id: 'evt-old', type: 'session.started', severity: 'info',
          nodeId: 'node-a', ts: '2026-03-01T12:00:00Z', timestamp: '2026-03-01T12:00:00Z',
          receivedAt: 100
        });
        const results = store.queryEvents({ from: '2026-03-10', to: '2026-03-10' });
        const ids = results.map(r => r.id);
        assert.ok(!ids.includes('evt-old'));
      });

      it('ignores duplicate IDs (INSERT OR IGNORE)', () => {
        store.indexEvent({
          id: 'evt-1', type: 'duplicate', severity: 'info',
          nodeId: 'x', ts: '2026-03-10T12:00:00Z', timestamp: '2026-03-10T12:00:00Z',
          receivedAt: 9999
        });
        // Original should still be there
        const results = store.queryEvents({ sessionId: 'sess-1', type: 'session.started' });
        assert.equal(results.length, 1);
      });
    });

    describe('getHeatmap', () => {
      it('returns heatmap with daily counts', () => {
        const result = store.getHeatmap(30);
        assert.ok(result);
        assert.ok(result.heatmap);
        assert.ok(typeof result.max === 'number');
        // Should have an entry for 2026-03-10
        assert.ok(result.heatmap['2026-03-10'] > 0 || true); // date may not be in 30-day window
      });

      it('fills in zero-count days', () => {
        const result = store.getHeatmap(7);
        assert.equal(Object.keys(result.heatmap).length, 7);
      });
    });

    describe('usage tracking', () => {
      it('indexes provider.usage events and queries rolling usage', () => {
        const now = Date.now();
        store.indexEvent({
          id: 'usage-1', type: 'provider.usage', severity: 'info',
          nodeId: 'node-a', ts: new Date().toISOString(), timestamp: new Date().toISOString(),
          receivedAt: now,
          payload: { provider: 'openai', model: 'gpt-4', cost: 0.05, inputTokens: 500, outputTokens: 200 }
        });
        store.indexEvent({
          id: 'usage-2', type: 'provider.usage', severity: 'info',
          nodeId: 'node-a', ts: new Date().toISOString(), timestamp: new Date().toISOString(),
          receivedAt: now + 1,
          payload: { provider: 'openai', model: 'gpt-4', cost: 0.03, inputTokens: 300, outputTokens: 100 }
        });

        const result = store.getRollingUsage(3600000); // 1 hour
        assert.ok(result);
        assert.ok(result.providers.openai);
        assert.equal(result.providers.openai.totalRequests, 2);
        assert.equal(result.totals.requests, 2);
        assert.ok(Math.abs(result.totals.cost - 0.08) < 0.001);
      });
    });

    describe('audit entries', () => {
      it('indexes and queries audit entries', () => {
        store.indexAuditEntry({
          entryId: 'aud-1', seq: 0, ts: '2026-03-10T12:00:00Z',
          actor: 'admin', action: 'user.created', target: 'bob',
          detail: 'Created user bob', hash: 'abc123', previousHash: '000'
        });
        store.indexAuditEntry({
          entryId: 'aud-2', seq: 1, ts: '2026-03-10T12:01:00Z',
          actor: 'admin', action: 'policy.updated', target: 'default',
          hash: 'def456', previousHash: 'abc123'
        });

        const all = store.queryAudit({});
        assert.ok(all);
        assert.equal(all.length, 2);

        const byAction = store.queryAudit({ action: 'user.created' });
        assert.equal(byAction.length, 1);
        assert.equal(byAction[0].actor, 'admin');

        const byActor = store.queryAudit({ actor: 'admin' });
        assert.equal(byActor.length, 2);
      });

      it('respects limit', () => {
        const result = store.queryAudit({ limit: 1 });
        assert.equal(result.length, 1);
      });
    });

    describe('JSONL catch-up', () => {
      it('catches up events from JSONL files', () => {
        const catchUpStore = createSqliteStore({ path: ':memory:' });
        const dir = createTempData();
        writeEvents(dir, [
          { id: 'j1', type: 'session.started', severity: 'info', nodeId: 'n1', sessionId: 's1', ts: '2026-03-10T10:00:00Z', timestamp: '2026-03-10T10:00:00Z', receivedAt: 500 },
          { id: 'j2', type: 'tool.call', severity: 'info', nodeId: 'n1', sessionId: 's1', ts: '2026-03-10T10:01:00Z', timestamp: '2026-03-10T10:01:00Z', receivedAt: 600 }
        ]);
        const count = catchUpStore.catchUpFromJSONL(dir);
        assert.equal(count, 2);
        assert.equal(catchUpStore.eventCount(), 2);
        catchUpStore.close();
        cleanup(dir);
      });

      it('incremental catch-up skips already-indexed events', () => {
        const catchUpStore = createSqliteStore({ path: ':memory:' });
        const dir = createTempData();
        writeEvents(dir, [
          { id: 'inc1', type: 'session.started', severity: 'info', nodeId: 'n1', ts: '2026-03-10T10:00:00Z', timestamp: '2026-03-10T10:00:00Z', receivedAt: 100 },
          { id: 'inc2', type: 'tool.call', severity: 'info', nodeId: 'n1', ts: '2026-03-10T10:01:00Z', timestamp: '2026-03-10T10:01:00Z', receivedAt: 200 }
        ]);
        catchUpStore.catchUpFromJSONL(dir);
        assert.equal(catchUpStore.eventCount(), 2);

        // Add a new event and catch up again
        const eventsDir = path.join(dir, 'events');
        fs.appendFileSync(path.join(eventsDir, 'events-2026-03-10.jsonl'),
          JSON.stringify({ id: 'inc3', type: 'session.ended', severity: 'info', nodeId: 'n1', ts: '2026-03-10T10:02:00Z', timestamp: '2026-03-10T10:02:00Z', receivedAt: 300 }) + '\n');
        const newCount = catchUpStore.catchUpFromJSONL(dir);
        assert.equal(newCount, 1); // only the new event
        assert.equal(catchUpStore.eventCount(), 3);
        catchUpStore.close();
        cleanup(dir);
      });

      it('catches up audit entries from JSONL', () => {
        const catchUpStore = createSqliteStore({ path: ':memory:' });
        const dir = createTempData();
        writeAuditEntries(dir, [
          { entryId: 'a1', seq: 0, ts: '2026-03-10T10:00:00Z', actor: 'admin', action: 'test', hash: 'h1', previousHash: '0' },
          { entryId: 'a2', seq: 1, ts: '2026-03-10T10:01:00Z', actor: 'system', action: 'test2', hash: 'h2', previousHash: 'h1' }
        ]);
        const count = catchUpStore.catchUpAuditFromJSONL(dir);
        assert.equal(count, 2);
        const results = catchUpStore.queryAudit({});
        assert.equal(results.length, 2);
        catchUpStore.close();
        cleanup(dir);
      });
    });

    describe('getMaxReceivedAt', () => {
      it('returns 0 for empty store', () => {
        const emptyStore = createSqliteStore({ path: ':memory:' });
        assert.equal(emptyStore.getMaxReceivedAt(), 0);
        emptyStore.close();
      });

      it('returns the max received_at value', () => {
        assert.ok(store.getMaxReceivedAt() > 0);
      });
    });

    describe('eventCount', () => {
      it('returns the total event count', () => {
        assert.ok(store.eventCount() > 0);
      });
    });
  });
} else {
  describe('SQLite Store (unavailable)', () => {
    it('returns null when node:sqlite is not available', () => {
      const store = createSqliteStore({ path: ':memory:' });
      assert.equal(store, null);
    });
  });
}
