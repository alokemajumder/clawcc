'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createContract, attachContract, loadContract, computeDrift, getEnforcementAction } = require('../../control-plane/lib/intent');

describe('createContract', () => {
  it('should return correct structure with all fields', () => {
    const contract = createContract('sess-001', {
      goal: 'Refactor auth module',
      constraints: ['no-network'],
      allowedTools: ['read', 'write'],
      allowedPaths: ['/src/auth'],
      allowedEndpoints: ['https://api.example.com'],
      maxBudget: 5.0,
      maxDuration: 3600
    });

    assert.equal(contract.sessionId, 'sess-001');
    assert.equal(contract.goal, 'Refactor auth module');
    assert.deepEqual(contract.constraints, ['no-network']);
    assert.deepEqual(contract.allowedTools, ['read', 'write']);
    assert.deepEqual(contract.allowedPaths, ['/src/auth']);
    assert.deepEqual(contract.allowedEndpoints, ['https://api.example.com']);
    assert.equal(contract.maxBudget, 5.0);
    assert.equal(contract.maxDuration, 3600);
    assert.ok(contract.createdAt);
  });

  it('should use defaults for missing options', () => {
    const contract = createContract('sess-002', {});
    assert.equal(contract.sessionId, 'sess-002');
    assert.equal(contract.goal, '');
    assert.deepEqual(contract.constraints, []);
    assert.deepEqual(contract.allowedTools, []);
    assert.deepEqual(contract.allowedPaths, []);
    assert.deepEqual(contract.allowedEndpoints, []);
    assert.equal(contract.maxBudget, Infinity);
    assert.equal(contract.maxDuration, Infinity);
  });
});

describe('attachContract and loadContract', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write contract to disk', () => {
    const contract = createContract('sess-100', { goal: 'test goal' });
    attachContract(tmpDir, 'sess-100', contract);

    const filePath = path.join(tmpDir, 'intents', 'sess-100.json');
    assert.ok(fs.existsSync(filePath), 'Contract file should exist on disk');

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(raw.sessionId, 'sess-100');
    assert.equal(raw.goal, 'test goal');
  });

  it('should read back the contract with loadContract', () => {
    const contract = createContract('sess-200', {
      goal: 'deploy service',
      allowedTools: ['bash', 'read']
    });
    attachContract(tmpDir, 'sess-200', contract);

    const loaded = loadContract(tmpDir, 'sess-200');
    assert.notEqual(loaded, null);
    assert.equal(loaded.sessionId, 'sess-200');
    assert.equal(loaded.goal, 'deploy service');
    assert.deepEqual(loaded.allowedTools, ['bash', 'read']);
  });

  it('should return null for missing session', () => {
    const result = loadContract(tmpDir, 'nonexistent-session');
    assert.equal(result, null);
  });

  it('should reject invalid sessionId with path traversal', () => {
    const contract = createContract('test', { goal: 'x' });
    assert.throws(
      () => attachContract(tmpDir, '../etc', contract),
      /Invalid session ID/
    );
  });

  it('should reject sessionId with dots', () => {
    const contract = createContract('test', { goal: 'x' });
    assert.throws(
      () => attachContract(tmpDir, 'foo.bar', contract),
      /Invalid session ID/
    );
  });

  it('should reject sessionId with slashes', () => {
    const contract = createContract('test', { goal: 'x' });
    assert.throws(
      () => attachContract(tmpDir, 'foo/bar', contract),
      /Invalid session ID/
    );
  });
});

describe('computeDrift', () => {
  it('should return 0 for empty events', () => {
    const contract = createContract('s1', { allowedTools: ['read'] });
    const result = computeDrift(contract, []);
    assert.equal(result.score, 0);
    assert.equal(result.reasons.length, 0);
  });

  it('should return 0 for null events', () => {
    const contract = createContract('s1', {});
    const result = computeDrift(contract, null);
    assert.equal(result.score, 0);
  });

  it('should return 0 for null contract', () => {
    const result = computeDrift(null, [{ type: 'tool.call', payload: { tool: 'bash' } }]);
    assert.equal(result.score, 0);
  });

  it('should detect tool divergence', () => {
    const contract = createContract('s2', {
      allowedTools: ['read', 'write']
    });
    const events = [
      { type: 'tool.call', payload: { tool: 'read' } },
      { type: 'tool.call', payload: { tool: 'bash' } },
      { type: 'tool.call', payload: { tool: 'curl' } }
    ];
    const result = computeDrift(contract, events);
    assert.ok(result.factors.toolDivergence > 0, 'toolDivergence should be > 0');
    assert.ok(result.score > 0, 'overall score should be > 0');
    assert.ok(result.reasons.some(r => r.includes('tool(s) used outside allowed set')));
  });

  it('should not flag tool divergence when all tools are allowed', () => {
    const contract = createContract('s3', {
      allowedTools: ['read', 'write']
    });
    const events = [
      { type: 'tool.call', payload: { tool: 'read' } },
      { type: 'tool.call', payload: { tool: 'write' } }
    ];
    const result = computeDrift(contract, events);
    assert.equal(result.factors.toolDivergence, 0);
  });

  it('should detect forbidden access via tripwire event', () => {
    const contract = createContract('s4', {});
    const events = [
      { type: 'tripwire.triggered', payload: { resource: '/etc/shadow' } }
    ];
    const result = computeDrift(contract, events);
    assert.equal(result.factors.forbiddenAccess, 20);
    assert.ok(result.reasons.some(r => r.includes('Forbidden resource access')));
  });

  it('should detect forbidden access via policy violation event', () => {
    const contract = createContract('s5', {});
    const events = [
      { type: 'policy.violation', payload: {} }
    ];
    const result = computeDrift(contract, events);
    assert.equal(result.factors.forbiddenAccess, 20);
  });

  it('should detect scope creep from file accesses outside allowed paths', () => {
    const contract = createContract('s6', {
      allowedPaths: ['/src/']
    });
    const events = [
      { type: 'file.read', payload: { path: '/src/index.js' } },
      { type: 'file.write', payload: { path: '/etc/passwd' } }
    ];
    const result = computeDrift(contract, events);
    assert.ok(result.factors.scopeCreep > 0);
  });

  it('should cap score at 100', () => {
    const contract = createContract('s7', {
      allowedTools: ['read']
    });
    // Create many divergent tools and a tripwire to push score high
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push({ type: 'tool.call', payload: { tool: `badtool-${i}` } });
    }
    events.push({ type: 'tripwire.triggered', payload: {} });
    const result = computeDrift(contract, events);
    assert.ok(result.score <= 100);
  });
});

describe('getEnforcementAction', () => {
  it('should return none for score below warn threshold', () => {
    assert.equal(getEnforcementAction(0), 'none');
    assert.equal(getEnforcementAction(19), 'none');
  });

  it('should return warn at default warn threshold (20)', () => {
    assert.equal(getEnforcementAction(20), 'warn');
    assert.equal(getEnforcementAction(39), 'warn');
  });

  it('should return approve at default approve threshold (40)', () => {
    assert.equal(getEnforcementAction(40), 'approve');
    assert.equal(getEnforcementAction(59), 'approve');
  });

  it('should return throttle at default throttle threshold (60)', () => {
    assert.equal(getEnforcementAction(60), 'throttle');
    assert.equal(getEnforcementAction(79), 'throttle');
  });

  it('should return quarantine at default quarantine threshold (80)', () => {
    assert.equal(getEnforcementAction(80), 'quarantine');
    assert.equal(getEnforcementAction(94), 'quarantine');
  });

  it('should return kill at default kill threshold (95)', () => {
    assert.equal(getEnforcementAction(95), 'kill');
    assert.equal(getEnforcementAction(100), 'kill');
  });

  it('should use custom thresholds when provided', () => {
    const custom = { warn: 10, approve: 25, throttle: 50, quarantine: 70, kill: 90 };
    assert.equal(getEnforcementAction(5, custom), 'none');
    assert.equal(getEnforcementAction(10, custom), 'warn');
    assert.equal(getEnforcementAction(25, custom), 'approve');
    assert.equal(getEnforcementAction(50, custom), 'throttle');
    assert.equal(getEnforcementAction(70, custom), 'quarantine');
    assert.equal(getEnforcementAction(90, custom), 'kill');
  });
});
