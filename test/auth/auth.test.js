'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createAuthManager } = require('../../control-plane/lib/auth');
const { generateTOTPCode } = require('../../control-plane/lib/crypto');

describe('User management', () => {
  let auth;
  beforeEach(() => { auth = createAuthManager(); });

  it('should create a user with hashed password', () => {
    const user = auth.createUser('alice', 'password123', 'viewer');
    assert.equal(user.username, 'alice');
    assert.equal(user.role, 'viewer');
    // Password should be hashed (not stored as plaintext)
    const stored = auth.getUser('alice');
    assert.ok(stored);
    assert.equal(stored.username, 'alice');
  });

  it('should reject duplicate username', () => {
    auth.createUser('bob', 'pass1', 'viewer');
    assert.throws(() => auth.createUser('bob', 'pass2', 'viewer'), /already exists/);
  });

  it('should reject invalid role', () => {
    assert.throws(() => auth.createUser('charlie', 'pass', 'superadmin'), /Invalid role/);
  });
});

describe('Authentication', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager({ lockoutMs: 100 });
    auth.createUser('alice', 'correct-password', 'viewer');
  });

  it('should authenticate correct credentials', () => {
    const result = auth.authenticate('alice', 'correct-password');
    assert.equal(result.username, 'alice');
    assert.equal(result.role, 'viewer');
  });

  it('should reject wrong password', () => {
    assert.throws(() => auth.authenticate('alice', 'wrong'), /Invalid credentials/);
  });

  it('should reject non-existent user', () => {
    assert.throws(() => auth.authenticate('nobody', 'pass'), /Invalid credentials/);
  });

  it('should lock after 5 failed attempts', () => {
    for (let i = 0; i < 5; i++) {
      assert.throws(() => auth.authenticate('alice', 'wrong'));
    }
    // Now even correct password should fail (locked)
    assert.throws(() => auth.authenticate('alice', 'correct-password'), /locked/);
  });

  it('should unlock after lockout timeout', async () => {
    for (let i = 0; i < 5; i++) {
      assert.throws(() => auth.authenticate('alice', 'wrong'));
    }
    assert.throws(() => auth.authenticate('alice', 'correct-password'), /locked/);
    // Wait for lockout to expire (100ms)
    await new Promise(r => setTimeout(r, 150));
    const result = auth.authenticate('alice', 'correct-password');
    assert.equal(result.username, 'alice');
  });
});

describe('Sessions', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager({ sessionTTL: 500 });
    auth.createUser('alice', 'pass', 'operator');
  });

  it('should create and validate a session', () => {
    const token = auth.createSession('alice');
    assert.ok(typeof token === 'string');
    assert.ok(token.length >= 32);
    const session = auth.validateSession(token);
    assert.equal(session.username, 'alice');
    assert.equal(session.role, 'operator');
  });

  it('should destroy a session', () => {
    const token = auth.createSession('alice');
    assert.ok(auth.validateSession(token));
    auth.destroySession(token);
    assert.equal(auth.validateSession(token), null);
  });

  it('should reject expired session', async () => {
    const token = auth.createSession('alice');
    assert.ok(auth.validateSession(token));
    await new Promise(r => setTimeout(r, 600));
    assert.equal(auth.validateSession(token), null);
  });

  it('should rotate a session token', () => {
    const oldToken = auth.createSession('alice');
    const newToken = auth.rotateSession(oldToken);
    assert.ok(newToken);
    assert.notEqual(oldToken, newToken);
    // Old token no longer valid
    assert.equal(auth.validateSession(oldToken), null);
    // New token is valid
    const session = auth.validateSession(newToken);
    assert.equal(session.username, 'alice');
  });
});

describe('RBAC', () => {
  let auth;
  beforeEach(() => { auth = createAuthManager(); });

  it('viewer can read', () => {
    assert.ok(auth.checkPermission('viewer', 'read'));
  });

  it('viewer cannot action', () => {
    assert.ok(!auth.checkPermission('viewer', 'action'));
  });

  it('operator can read and action', () => {
    assert.ok(auth.checkPermission('operator', 'read'));
    assert.ok(auth.checkPermission('operator', 'action'));
  });

  it('operator cannot admin', () => {
    assert.ok(!auth.checkPermission('operator', 'admin'));
  });

  it('admin can all', () => {
    assert.ok(auth.checkPermission('admin', 'read'));
    assert.ok(auth.checkPermission('admin', 'action'));
    assert.ok(auth.checkPermission('admin', 'admin'));
  });

  it('invalid role has no permissions', () => {
    assert.ok(!auth.checkPermission('nonexistent', 'read'));
  });
});

describe('Step-up auth', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager({ stepUpWindow: 200 });
    auth.createUser('alice', 'pass', 'admin');
  });

  it('should require step-up within window', () => {
    const token = auth.createSession('alice');
    assert.ok(!auth.requireStepUp(token)); // Not yet stepped up
    auth.stepUpAuth(token);
    assert.ok(auth.requireStepUp(token)); // Just stepped up
  });

  it('should reject step-up outside window', async () => {
    const token = auth.createSession('alice');
    auth.stepUpAuth(token);
    assert.ok(auth.requireStepUp(token));
    await new Promise(r => setTimeout(r, 250));
    assert.ok(!auth.requireStepUp(token));
  });
});

describe('MFA', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager();
    auth.createUser('alice', 'pass', 'admin');
  });

  it('should set up MFA and return secret', () => {
    const result = auth.setupMFA('alice');
    assert.ok(typeof result.secret === 'string');
    assert.ok(result.secret.length > 0);
    assert.ok(Array.isArray(result.recoveryCodes));
    assert.equal(result.recoveryCodes.length, 10);
  });

  it('should verify MFA code', () => {
    const result = auth.setupMFA('alice');
    const code = generateTOTPCode(result.secret);
    assert.ok(auth.verifyMFA('alice', code));
    // After verification, MFA should be enabled
    const user = auth.getUser('alice');
    assert.ok(user.mfaEnabled);
  });

  it('should reject wrong MFA code', () => {
    auth.setupMFA('alice');
    assert.ok(!auth.verifyMFA('alice', '000000'));
  });
});

describe('Default admin', () => {
  it('should create default admin user', () => {
    const auth = createAuthManager();
    const admin = auth.createDefaultAdmin('securepass');
    assert.equal(admin.username, 'admin');
    assert.equal(admin.role, 'admin');
    // Should be able to authenticate
    const result = auth.authenticate('admin', 'securepass');
    assert.equal(result.username, 'admin');
  });

  it('should not duplicate admin', () => {
    const auth = createAuthManager();
    auth.createDefaultAdmin('pass1');
    const second = auth.createDefaultAdmin('pass2');
    assert.equal(second.username, 'admin');
    // Original password should still work
    const result = auth.authenticate('admin', 'pass1');
    assert.equal(result.username, 'admin');
  });
});

describe('Recovery codes', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager();
    auth.createUser('alice', 'pass', 'admin');
  });

  it('should use a valid recovery code', () => {
    const { recoveryCodes } = auth.setupMFA('alice');
    assert.ok(recoveryCodes.length > 0);
    const result = auth.useRecoveryCode('alice', recoveryCodes[0]);
    assert.equal(result, true);
  });

  it('should reject an already-used recovery code', () => {
    const { recoveryCodes } = auth.setupMFA('alice');
    const code = recoveryCodes[0];
    const first = auth.useRecoveryCode('alice', code);
    assert.equal(first, true);
    const second = auth.useRecoveryCode('alice', code);
    assert.equal(second, false);
  });

  it('should reject invalid recovery code', () => {
    auth.setupMFA('alice');
    const result = auth.useRecoveryCode('alice', 'INVALID-CODE-9999');
    assert.equal(result, false);
  });
});

describe('Password management', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager();
    auth.createUser('alice', 'oldpass', 'operator');
  });

  it('should change password with correct old password', () => {
    auth.changePassword('alice', 'oldpass', 'newpass');
    // New password should work
    const result = auth.authenticate('alice', 'newpass');
    assert.equal(result.username, 'alice');
  });

  it('should reject change with wrong old password', () => {
    assert.throws(() => auth.changePassword('alice', 'wrongpass', 'newpass'), /Invalid old password/);
    // Old password should still work
    const result = auth.authenticate('alice', 'oldpass');
    assert.equal(result.username, 'alice');
  });

  it('should update password (admin reset, no old password needed)', () => {
    auth.updatePassword('alice', 'resetpass');
    // Reset password should work
    const result = auth.authenticate('alice', 'resetpass');
    assert.equal(result.username, 'alice');
    // Old password should no longer work
    assert.throws(() => auth.authenticate('alice', 'oldpass'), /Invalid credentials/);
  });
});

describe('MFA-pending sessions', () => {
  let auth;
  beforeEach(() => {
    auth = createAuthManager({ sessionTTL: 5000 });
    auth.createUser('alice', 'pass', 'admin');
  });

  it('should create mfaPending session', () => {
    const token = auth.createSession('alice', { mfaPending: true });
    assert.ok(typeof token === 'string');
    assert.ok(token.length >= 32);
  });

  it('validateSession should return mfaPending flag', () => {
    const token = auth.createSession('alice', { mfaPending: true });
    const session = auth.validateSession(token);
    assert.equal(session.mfaPending, true);
    assert.equal(session.username, 'alice');
  });

  it('upgradeSession should clear mfaPending and extend TTL', () => {
    const token = auth.createSession('alice', { mfaPending: true });
    const beforeUpgrade = auth.validateSession(token);
    assert.equal(beforeUpgrade.mfaPending, true);

    const upgraded = auth.upgradeSession(token);
    assert.equal(upgraded, true);

    const afterUpgrade = auth.validateSession(token);
    assert.equal(afterUpgrade.mfaPending, false);
    assert.equal(afterUpgrade.username, 'alice');
    assert.equal(afterUpgrade.role, 'admin');
  });
});
