'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createEventStore } = require('../../control-plane/lib/events');

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), 'clawcc-events-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(overrides = {}) {
  return {
    type: 'command',
    severity: 'info',
    nodeId: 'node-1',
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

describe('Ingest valid event', () => {
  it('should ingest and return stored event', () => {
    const store = createEventStore();
    const event = makeEvent();
    const stored = store.ingest(event);
    assert.ok(stored.id);
    assert.ok(stored.receivedAt);
    assert.equal(stored.type, 'command');
  });
});

describe('Reject event missing required fields', () => {
  it('should reject event without type', () => {
    const store = createEventStore();
    assert.throws(() => store.ingest({ severity: 'info', nodeId: 'n1', timestamp: '2024-01-01' }), /Missing required field: type/);
  });

  it('should reject event without severity', () => {
    const store = createEventStore();
    assert.throws(() => store.ingest({ type: 'cmd', nodeId: 'n1', timestamp: '2024-01-01' }), /Missing required field: severity/);
  });

  it('should reject event without nodeId', () => {
    const store = createEventStore();
    assert.throws(() => store.ingest({ type: 'cmd', severity: 'info', timestamp: '2024-01-01' }), /Missing required field: nodeId/);
  });

  it('should reject event without timestamp', () => {
    const store = createEventStore();
    assert.throws(() => store.ingest({ type: 'cmd', severity: 'info', nodeId: 'n1' }), /Missing required field: timestamp/);
  });

  it('should reject invalid severity', () => {
    const store = createEventStore();
    assert.throws(() => store.ingest(makeEvent({ severity: 'fatal' })), /Invalid severity/);
  });
});

describe('Secret redaction', () => {
  it('should redact password field in object payload', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: { tool: 'Bash', password: 'supersecret123' } });
    const stored = store.ingest(event);
    assert.equal(stored.payload.password, '***REDACTED***');
    assert.equal(stored.payload.tool, 'Bash');
  });

  it('should redact Bearer token in string payload', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: 'Authorization: Bearer eyJhbGciOi.token.value' });
    const stored = store.ingest(event);
    assert.ok(!stored.payload.includes('eyJhbGciOi.token.value'));
    assert.ok(stored.payload.includes('REDACTED'));
  });

  it('should redact api_key field in object payload', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: { api_key: 'sk-12345abc', model: 'gpt-4' } });
    const stored = store.ingest(event);
    assert.equal(stored.payload.api_key, '***REDACTED***');
    assert.equal(stored.payload.model, 'gpt-4');
  });

  it('should redact Bearer token embedded in object string value', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: { header: 'Bearer eyJhbGciOi.abc.def', tool: 'curl' } });
    const stored = store.ingest(event);
    assert.ok(!stored.payload.header.includes('eyJhbGciOi.abc.def'));
    assert.ok(stored.payload.header.includes('REDACTED'));
    assert.equal(stored.payload.tool, 'curl');
  });

  it('should redact nested secret fields', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: { config: { secret: 'mysecret', host: 'localhost' } } });
    const stored = store.ingest(event);
    assert.equal(stored.payload.config.secret, '***REDACTED***');
    assert.equal(stored.payload.config.host, 'localhost');
  });

  it('should return object payload as object (not string)', () => {
    const store = createEventStore();
    const event = makeEvent({ payload: { tool: 'Read', path: '/tmp/test.txt' } });
    const stored = store.ingest(event);
    assert.equal(typeof stored.payload, 'object');
    assert.equal(stored.payload.tool, 'Read');
  });
});

describe('Payload size limit', () => {
  it('should reject oversized payload', () => {
    const store = createEventStore({ maxPayloadSize: 200 });
    const bigPayload = 'X'.repeat(300);
    assert.throws(() => store.ingest(makeEvent({ payload: bigPayload })), /size limit/);
  });

  it('should accept payload within limit', () => {
    const store = createEventStore({ maxPayloadSize: 1000 });
    const event = makeEvent({ payload: 'small' });
    const stored = store.ingest(event);
    assert.ok(stored.id);
  });
});

describe('Subscribe and receive events', () => {
  it('should notify subscriber on new event', () => {
    const store = createEventStore();
    const received = [];
    store.subscribe((event) => received.push(event));
    store.ingest(makeEvent({ type: 'test-sub' }));
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'test-sub');
  });

  it('should support multiple subscribers', () => {
    const store = createEventStore();
    const a = [], b = [];
    store.subscribe(e => a.push(e));
    store.subscribe(e => b.push(e));
    store.ingest(makeEvent());
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it('should support unsubscribe', () => {
    const store = createEventStore();
    const received = [];
    const unsub = store.subscribe(e => received.push(e));
    store.ingest(makeEvent());
    assert.equal(received.length, 1);
    unsub();
    store.ingest(makeEvent());
    assert.equal(received.length, 1); // No new event
  });
});

describe('Query with date range filter', () => {
  it('should filter events by date range', () => {
    const store = createEventStore();
    store.ingest(makeEvent({ timestamp: '2024-01-01T10:00:00Z' }));
    store.ingest(makeEvent({ timestamp: '2024-06-15T10:00:00Z' }));
    store.ingest(makeEvent({ timestamp: '2024-12-31T10:00:00Z' }));
    const results = store.query({ startDate: '2024-06-01', endDate: '2024-07-01' });
    assert.equal(results.length, 1);
    assert.equal(results[0].timestamp, '2024-06-15T10:00:00Z');
  });
});

describe('Query with type/severity/node filters', () => {
  let store;
  beforeEach(() => {
    store = createEventStore();
    store.ingest(makeEvent({ type: 'command', severity: 'info', nodeId: 'node-1', timestamp: new Date().toISOString() }));
    store.ingest(makeEvent({ type: 'file_write', severity: 'warning', nodeId: 'node-2', timestamp: new Date().toISOString() }));
    store.ingest(makeEvent({ type: 'network', severity: 'error', nodeId: 'node-1', timestamp: new Date().toISOString() }));
  });

  it('should filter by type', () => {
    const results = store.query({ type: 'command' });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'command');
  });

  it('should filter by severity', () => {
    const results = store.query({ severity: 'warning' });
    assert.equal(results.length, 1);
    assert.equal(results[0].severity, 'warning');
  });

  it('should filter by nodeId', () => {
    const results = store.query({ nodeId: 'node-1' });
    assert.equal(results.length, 2);
  });

  it('should combine filters', () => {
    const results = store.query({ nodeId: 'node-1', severity: 'error' });
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'network');
  });
});

describe('JSONL file format', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write events as JSONL', async () => {
    tmpDir = makeTmpDir();
    const store = createEventStore({ dataDir: tmpDir });
    store.ingest(makeEvent({ type: 'evt1' }));
    store.ingest(makeEvent({ type: 'evt2' }));
    // Writes are async via queue; wait for drain
    await new Promise(resolve => setTimeout(resolve, 100));
    const files = fs.readdirSync(tmpDir);
    assert.ok(files.length > 0);
    assert.ok(files[0].endsWith('.jsonl'));

    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, 'evt1');
    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.type, 'evt2');
  });
});
