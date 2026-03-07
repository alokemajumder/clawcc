'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// We need to clear the module cache so each test file gets a fresh nonceTracker
delete require.cache[require.resolve('../../control-plane/middleware/auth-middleware')];
const { authenticate, requireAuth, verifyNodeSignature } = require('../../control-plane/middleware/auth-middleware');
const { signRequest } = require('../../control-plane/lib/crypto');

// ── Helpers ──

function createMockAuthModule(sessions = {}) {
  return {
    validateSession(token) {
      return sessions[token] || null;
    },
    getSession(token) {
      return sessions[token] || null;
    }
  };
}

function createMockCryptoModule({ verifyResult = true } = {}) {
  return {
    verifyRequest() {
      return verifyResult;
    }
  };
}

function makeNodeRequest({ method = 'POST', url = '/api/nodes/heartbeat', headers = {} } = {}) {
  return { method, url, headers, cookies: {} };
}

// ── authenticate() ──

describe('authenticate()', () => {
  it('returns authenticated:false with no cookie', () => {
    const auth = createMockAuthModule();
    const req = { cookies: {} };
    const result = authenticate(req, auth);
    assert.equal(result.authenticated, false);
    assert.equal(result.error, 'No session cookie');
  });

  it('returns authenticated:false when cookies is undefined', () => {
    const auth = createMockAuthModule();
    const req = {};
    const result = authenticate(req, auth);
    assert.equal(result.authenticated, false);
    assert.equal(result.error, 'No session cookie');
  });

  it('returns authenticated:true with valid session', () => {
    const user = { username: 'admin', role: 'admin' };
    const auth = createMockAuthModule({ 'valid-token': user });
    const req = { cookies: { clawcc_session: 'valid-token' } };
    const result = authenticate(req, auth);
    assert.equal(result.authenticated, true);
    assert.deepStrictEqual(result.user, user);
  });

  it('blocks mfaPending sessions (returns authenticated:false)', () => {
    const user = { username: 'admin', role: 'admin', mfaPending: true };
    const auth = createMockAuthModule({ 'mfa-token': user });
    const req = { cookies: { clawcc_session: 'mfa-token' } };
    const result = authenticate(req, auth);
    assert.equal(result.authenticated, false);
    assert.equal(result.error, 'MFA verification required');
  });
});

// ── requireAuth() ──

describe('requireAuth()', () => {
  it('allows matching roles', () => {
    const user = { username: 'admin', role: 'admin' };
    const auth = createMockAuthModule({ 'tok': user });
    const middleware = requireAuth(auth, ['admin', 'operator']);
    const req = { cookies: { clawcc_session: 'tok' } };
    const result = middleware(req, {});
    assert.equal(result.authorized, true);
    assert.deepStrictEqual(result.user, user);
  });

  it('rejects non-matching roles', () => {
    const user = { username: 'viewer', role: 'viewer' };
    const auth = createMockAuthModule({ 'tok': user });
    const middleware = requireAuth(auth, ['admin']);
    const req = { cookies: { clawcc_session: 'tok' } };
    const result = middleware(req, {});
    assert.equal(result.authorized, false);
    assert.deepStrictEqual(result.user, user);
  });
});

// ── verifyNodeSignature() ──

describe('verifyNodeSignature()', () => {
  const validSecret = 'a-real-secret-not-default';

  function validHeaders() {
    const ts = Date.now().toString();
    const nonce = crypto.randomUUID();
    const method = 'POST';
    const path = '/api/nodes/heartbeat';
    const sig = signRequest(validSecret, method, path, ts, '');
    return {
      'x-clawcc-nodeid': 'node-1',
      'x-clawcc-timestamp': ts,
      'x-clawcc-nonce': nonce,
      'x-clawcc-signature': sig
    };
  }

  it('rejects missing headers', () => {
    const req = makeNodeRequest({ headers: {} });
    const config = { sessionSecret: validSecret };
    const result = verifyNodeSignature(req, config, createMockCryptoModule());
    assert.equal(result.valid, false);
    assert.match(result.error, /Missing required signature headers/);
  });

  it('rejects expired timestamps', () => {
    const ts = (Date.now() - 600000).toString(); // 10 min ago, well past 5 min default
    const nonce = crypto.randomUUID();
    const sig = signRequest(validSecret, 'POST', '/api/nodes/heartbeat', ts, '');
    const req = makeNodeRequest({
      headers: {
        'x-clawcc-nodeid': 'node-1',
        'x-clawcc-timestamp': ts,
        'x-clawcc-nonce': nonce,
        'x-clawcc-signature': sig
      }
    });
    const config = { sessionSecret: validSecret };
    const result = verifyNodeSignature(req, config, createMockCryptoModule());
    assert.equal(result.valid, false);
    assert.match(result.error, /timestamp expired/);
  });

  it('rejects replayed nonces', () => {
    const config = { sessionSecret: validSecret };
    const cryptoMod = createMockCryptoModule({ verifyResult: true });
    const headers = validHeaders();
    const req1 = makeNodeRequest({ headers: { ...headers } });
    const result1 = verifyNodeSignature(req1, config, cryptoMod);
    assert.equal(result1.valid, true);

    // Replay same nonce
    const req2 = makeNodeRequest({ headers: { ...headers } });
    const result2 = verifyNodeSignature(req2, config, cryptoMod);
    assert.equal(result2.valid, false);
    assert.match(result2.error, /replay detected/i);
  });

  it('rejects when no sessionSecret configured', () => {
    const config = { sessionSecret: 'default-secret' };
    const headers = validHeaders();
    // Remove node-specific secret path so it falls through to sessionSecret check
    const req = makeNodeRequest({ headers });
    const result = verifyNodeSignature(req, config, createMockCryptoModule());
    assert.equal(result.valid, false);
    assert.match(result.error, /No node secret configured/);
  });

  it('also rejects when sessionSecret is missing entirely', () => {
    const config = {};
    const headers = validHeaders();
    const req = makeNodeRequest({ headers });
    const result = verifyNodeSignature(req, config, createMockCryptoModule());
    assert.equal(result.valid, false);
    assert.match(result.error, /No node secret configured/);
  });
});
