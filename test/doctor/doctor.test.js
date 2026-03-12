'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createDoctor } = require('../../control-plane/lib/doctor');
const { createBackupManager } = require('../../control-plane/lib/backup');
const { createAuthManager } = require('../../control-plane/lib/auth');
const { createReceiptStore } = require('../../control-plane/lib/receipts');

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), 'clawcc-doctor-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupDataDir(tmpDir) {
  const dirs = ['events', 'snapshots', 'audit', 'receipts', 'receipts/roots', 'fleet', 'intents', 'users'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }
  return tmpDir;
}

// ── Doctor Tests ──

describe('Doctor: config-valid check', () => {
  it('should pass when required config fields are present', () => {
    const doctor = createDoctor({ config: { port: 3400, dataDir: '/tmp', sessionSecret: 'test-secret' }, dataDir: '/tmp' });
    const result = doctor.runCheck('config-valid');
    assert.equal(result.status, 'pass');
  });

  it('should fail when port is missing', () => {
    const doctor = createDoctor({ config: { dataDir: '/tmp', sessionSecret: 'secret' }, dataDir: '/tmp' });
    const result = doctor.runCheck('config-valid');
    assert.equal(result.status, 'fail');
    assert.ok(result.message.includes('port'));
  });
});

describe('Doctor: data-dir-writable check', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should pass when data dir exists and is writable', () => {
    tmpDir = makeTmpDir();
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir });
    const result = doctor.runCheck('data-dir-writable');
    assert.equal(result.status, 'pass');
  });

  it('should fail when data dir does not exist', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/nonexistent-path-' + crypto.randomBytes(8).toString('hex') });
    const result = doctor.runCheck('data-dir-writable');
    assert.equal(result.status, 'fail');
    assert.equal(result.fixable, true);
  });
});

describe('Doctor: data-dir-writable fix', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create missing data directory', () => {
    tmpDir = path.join(os.tmpdir(), 'clawcc-doctor-fix-' + crypto.randomBytes(4).toString('hex'));
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir });
    const checkBefore = doctor.runCheck('data-dir-writable');
    assert.equal(checkBefore.status, 'fail');
    const fix = doctor.applyFix('data-dir-writable');
    assert.equal(fix.success, true);
    const checkAfter = doctor.runCheck('data-dir-writable');
    assert.equal(checkAfter.status, 'pass');
  });
});

describe('Doctor: hmac-not-default check', () => {
  it('should warn when session secret is a default value', () => {
    const doctor = createDoctor({ config: { port: 3400, sessionSecret: 'change-me-in-production' }, dataDir: '/tmp' });
    const result = doctor.runCheck('hmac-not-default');
    assert.equal(result.status, 'warn');
    assert.equal(result.fixable, true);
  });

  it('should pass when session secret is custom', () => {
    const doctor = createDoctor({ config: { port: 3400, sessionSecret: 'my-custom-secret-12345' }, dataDir: '/tmp' });
    const result = doctor.runCheck('hmac-not-default');
    assert.equal(result.status, 'pass');
  });
});

describe('Doctor: hmac-not-default fix', () => {
  it('should generate a new secret', () => {
    const config = { port: 3400, sessionSecret: 'change-me-in-production' };
    const doctor = createDoctor({ config, dataDir: '/tmp' });
    const fix = doctor.applyFix('hmac-not-default');
    assert.equal(fix.success, true);
    assert.ok(fix.secret);
    assert.equal(fix.secret.length, 64); // 32 bytes hex
    assert.equal(config.sessionSecret, fix.secret);
  });
});

describe('Doctor: admin-password-changed check', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should warn when admin password is default', () => {
    tmpDir = makeTmpDir();
    const authManager = createAuthManager({ dataDir: tmpDir });
    authManager.createDefaultAdmin('changeme');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir, authManager });
    const result = doctor.runCheck('admin-password-changed');
    assert.equal(result.status, 'warn');
    assert.equal(result.fixable, true);
  });

  it('should pass when admin password was changed', () => {
    tmpDir = makeTmpDir();
    const authManager = createAuthManager({ dataDir: tmpDir });
    authManager.createDefaultAdmin('changeme');
    authManager.updatePassword('admin', 'new-secure-password');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir, authManager });
    const result = doctor.runCheck('admin-password-changed');
    assert.equal(result.status, 'pass');
  });

  it('should skip when auth manager not available', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const result = doctor.runCheck('admin-password-changed');
    assert.equal(result.status, 'skip');
  });
});

describe('Doctor: admin-password-changed fix', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reset admin password to a random one', () => {
    tmpDir = makeTmpDir();
    const authManager = createAuthManager({ dataDir: tmpDir });
    authManager.createDefaultAdmin('changeme');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir, authManager });
    const fix = doctor.applyFix('admin-password-changed');
    assert.equal(fix.success, true);
    assert.ok(fix.newPassword);
    // The old password should no longer work
    assert.throws(() => authManager.authenticate('admin', 'changeme'));
    // The new password should work
    const user = authManager.authenticate('admin', fix.newPassword);
    assert.equal(user.username, 'admin');
  });
});

describe('Doctor: tls-configured check', () => {
  it('should skip in dev mode', () => {
    const doctor = createDoctor({ config: { port: 3400, mode: 'local' }, dataDir: '/tmp' });
    const result = doctor.runCheck('tls-configured');
    assert.equal(result.status, 'skip');
  });

  it('should warn in production without TLS', () => {
    const doctor = createDoctor({ config: { port: 3400, mode: 'production' }, dataDir: '/tmp' });
    const result = doctor.runCheck('tls-configured');
    assert.equal(result.status, 'warn');
  });

  it('should pass in production with TLS configured', () => {
    const doctor = createDoctor({ config: { port: 3400, mode: 'production', httpsEnabled: true, httpsKeyPath: '/key', httpsCertPath: '/cert' }, dataDir: '/tmp' });
    const result = doctor.runCheck('tls-configured');
    assert.equal(result.status, 'pass');
  });
});

describe('Doctor: event-chain-integrity check', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should skip when no event files exist', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir });
    const result = doctor.runCheck('event-chain-integrity');
    assert.equal(result.status, 'skip');
  });

  it('should pass for valid JSONL', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const eventsDir = path.join(tmpDir, 'events');
    fs.writeFileSync(path.join(eventsDir, 'events-2024-01-01.jsonl'),
      '{"type":"command","id":"1"}\n{"type":"command","id":"2"}\n');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir });
    const result = doctor.runCheck('event-chain-integrity');
    assert.equal(result.status, 'pass');
  });

  it('should warn for corrupt JSONL', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const eventsDir = path.join(tmpDir, 'events');
    fs.writeFileSync(path.join(eventsDir, 'events-2024-01-01.jsonl'),
      '{"type":"command"}\nnot-json\n{"type":"command"}\n');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: tmpDir });
    const result = doctor.runCheck('event-chain-integrity');
    assert.equal(result.status, 'warn');
    assert.ok(result.message.includes('corrupt'));
  });
});

describe('Doctor: receipt-chain-valid check', () => {
  it('should pass with valid receipt chain', () => {
    const receiptStore = createReceiptStore({});
    receiptStore.createReceipt('data1');
    receiptStore.createReceipt('data2');
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp', receiptStore });
    const result = doctor.runCheck('receipt-chain-valid');
    assert.equal(result.status, 'pass');
  });

  it('should skip when receipt store not available', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const result = doctor.runCheck('receipt-chain-valid');
    assert.equal(result.status, 'skip');
  });
});

describe('Doctor: memory-usage check', () => {
  it('should return pass or warn with heap info', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const result = doctor.runCheck('memory-usage');
    assert.ok(result.status === 'pass' || result.status === 'warn');
    assert.ok(result.message.includes('Heap'));
  });
});

describe('Doctor: runAll', () => {
  it('should return results for all checks', () => {
    const doctor = createDoctor({ config: { port: 3400, sessionSecret: 'test' }, dataDir: '/tmp' });
    const results = doctor.runAll();
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 10);
    for (const r of results) {
      assert.ok(r.id);
      assert.ok(r.name);
      assert.ok(['pass', 'warn', 'fail', 'skip'].includes(r.status));
    }
  });
});

describe('Doctor: unknown check and fix', () => {
  it('should return null for unknown check', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const result = doctor.runCheck('nonexistent');
    assert.equal(result, null);
  });

  it('should return failure for unknown fix', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const result = doctor.applyFix('nonexistent');
    assert.equal(result.success, false);
  });
});

describe('Doctor: getCheckIds and getFixableChecks', () => {
  it('should list all check IDs', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const ids = doctor.getCheckIds();
    assert.ok(ids.includes('config-valid'));
    assert.ok(ids.includes('hmac-not-default'));
    assert.ok(ids.includes('memory-usage'));
  });

  it('should list fixable check IDs', () => {
    const doctor = createDoctor({ config: { port: 3400 }, dataDir: '/tmp' });
    const fixable = doctor.getFixableChecks();
    assert.ok(fixable.includes('hmac-not-default'));
    assert.ok(fixable.includes('admin-password-changed'));
    assert.ok(fixable.includes('data-dir-writable'));
    assert.ok(fixable.includes('stale-sessions'));
  });
});

// ── Backup Manager Tests ──

describe('Backup: createBackup and listBackups', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a backup and list it', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    // Write some test data
    fs.writeFileSync(path.join(tmpDir, 'events', 'events-2024-01-01.jsonl'), '{"test":true}\n');
    fs.writeFileSync(path.join(tmpDir, 'audit', '2024-01-01.jsonl'), '{"audit":true}\n');

    const mgr = createBackupManager({ dataDir: tmpDir });
    const backup = mgr.createBackup();
    assert.ok(backup.id);
    assert.ok(backup.createdAt);
    assert.ok(backup.fileCount >= 2);
    assert.ok(backup.totalSize > 0);

    const backups = mgr.listBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].id, backup.id);
  });
});

describe('Backup: restoreBackup', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should restore files from a backup', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'events', 'events-2024-01-01.jsonl'), '{"test":"original"}\n');

    const mgr = createBackupManager({ dataDir: tmpDir });
    const backup = mgr.createBackup();

    // Overwrite the original file
    fs.writeFileSync(path.join(tmpDir, 'events', 'events-2024-01-01.jsonl'), '{"test":"modified"}\n');

    // Restore
    const result = mgr.restoreBackup(backup.id);
    assert.equal(result.success, true);
    assert.ok(result.restoredFiles > 0);

    // Verify file was restored
    const content = fs.readFileSync(path.join(tmpDir, 'events', 'events-2024-01-01.jsonl'), 'utf8');
    assert.ok(content.includes('original'));
  });

  it('should fail for nonexistent backup', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const mgr = createBackupManager({ dataDir: tmpDir });
    const result = mgr.restoreBackup('nonexistent-id');
    assert.equal(result.success, false);
  });

  it('should reject path traversal in backup ID', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const mgr = createBackupManager({ dataDir: tmpDir });
    const result = mgr.restoreBackup('../../../etc/passwd');
    assert.equal(result.success, false);
    assert.ok(result.message.includes('Invalid'));
  });
});

describe('Backup: deleteBackup', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should delete an existing backup', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'events', 'events-2024-01-01.jsonl'), '{"test":true}\n');

    const mgr = createBackupManager({ dataDir: tmpDir });
    const backup = mgr.createBackup();
    assert.equal(mgr.listBackups().length, 1);

    const result = mgr.deleteBackup(backup.id);
    assert.equal(result.success, true);
    assert.equal(mgr.listBackups().length, 0);
  });

  it('should fail for nonexistent backup', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const mgr = createBackupManager({ dataDir: tmpDir });
    const result = mgr.deleteBackup('nonexistent-id');
    assert.equal(result.success, false);
  });

  it('should reject path traversal in delete', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    const mgr = createBackupManager({ dataDir: tmpDir });
    const result = mgr.deleteBackup('../../../etc');
    assert.equal(result.success, false);
    assert.ok(result.message.includes('Invalid'));
  });
});

describe('Backup: multiple backups ordering', () => {
  let tmpDir;
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should list backups in reverse chronological order', () => {
    tmpDir = makeTmpDir();
    setupDataDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'events', 'test.jsonl'), '{"test":true}\n');

    const mgr = createBackupManager({ dataDir: tmpDir });
    const b1 = mgr.createBackup();
    const b2 = mgr.createBackup();

    const backups = mgr.listBackups();
    assert.equal(backups.length, 2);
    // Both backups present
    const ids = backups.map(b => b.id);
    assert.ok(ids.includes(b1.id), 'b1 should be in list');
    assert.ok(ids.includes(b2.id), 'b2 should be in list');
    // Sorted by date descending (or equal when same millisecond)
    const t0 = new Date(backups[0].createdAt).getTime();
    const t1 = new Date(backups[1].createdAt).getTime();
    assert.ok(t0 >= t1, 'should be sorted newest first');
  });
});
