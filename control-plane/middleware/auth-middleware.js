'use strict';

const crypto = require('crypto');
const { createNonceTracker } = require('../lib/crypto');

// Module-level nonce tracker — prevents replay attacks on signed requests
const nonceTracker = createNonceTracker(300000); // 5 min window

function authenticate(req, authModule) {
  const token = req.cookies && req.cookies.clawcc_session;
  if (!token) {
    return { authenticated: false, error: 'No session cookie' };
  }
  const user = authModule.validateSession(token);
  if (!user) {
    return { authenticated: false, error: 'Invalid or expired session' };
  }
  // Block MFA-pending sessions from accessing any authenticated endpoint
  if (user.mfaPending) {
    return { authenticated: false, error: 'MFA verification required' };
  }
  return { authenticated: true, user };
}

function requireAuth(authModule, roles) {
  return function(req, res) {
    const result = authenticate(req, authModule);
    if (!result.authenticated) {
      return { authorized: false, user: null };
    }
    if (roles && roles.length > 0 && !roles.includes(result.user.role)) {
      return { authorized: false, user: result.user };
    }
    return { authorized: true, user: result.user };
  };
}

function requireStepUp(req, authModule, config) {
  const token = req.cookies && req.cookies.clawcc_session;
  if (!token) return { authorized: false, reason: 'No session' };

  const session = authModule.getSession(token);
  if (!session) return { authorized: false, reason: 'Invalid session' };

  const windowMs = (config && config.auth && config.auth.stepUpWindowMs) || 300000;
  if (!session.lastStepUp || Date.now() - session.lastStepUp > windowMs) {
    return { authorized: false, reason: 'Step-up authentication required' };
  }
  return { authorized: true };
}

function verifyNodeSignature(req, config, cryptoModule) {
  const nodeId = req.headers['x-clawcc-nodeid'];
  const timestamp = req.headers['x-clawcc-timestamp'];
  const nonce = req.headers['x-clawcc-nonce'];
  const signature = req.headers['x-clawcc-signature'];

  if (!nodeId || !timestamp || !nonce || !signature) {
    return { valid: false, error: 'Missing required signature headers' };
  }

  const ts = parseInt(timestamp, 10);
  const maxAge = (config && config.fleet && config.fleet.signatureMaxAge) || 300000;
  if (Math.abs(Date.now() - ts) > maxAge) {
    return { valid: false, error: 'Request timestamp expired' };
  }

  // Reject replayed nonces
  if (!nonceTracker.accept(nonce)) {
    return { valid: false, error: 'Nonce already used (replay detected)' };
  }

  const nodeSecret = config.fleet && config.fleet.nodeSecrets && config.fleet.nodeSecrets[nodeId];
  if (!nodeSecret && (!config.sessionSecret || config.sessionSecret === 'default-secret')) {
    return { valid: false, error: 'No node secret configured — set config.sessionSecret or config.fleet.nodeSecrets' };
  }
  const secret = nodeSecret || config.sessionSecret;

  const method = req.method;
  const path = req.url;
  const valid = cryptoModule.verifyRequest(secret, method, path, timestamp, '', signature, maxAge);

  if (!valid) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true, nodeId };
}

module.exports = { authenticate, requireAuth, requireStepUp, verifyNodeSignature };
