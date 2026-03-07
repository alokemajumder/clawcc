'use strict';
const { parseBody } = require('../middleware/security');
const { authenticate } = require('../middleware/auth-middleware');

function registerAuthRoutes(router, config, modules) {
  const { auth, audit, crypto: cryptoMod } = modules;
  const authRateLimit = new Map(); // ip -> {count, windowStart}

  function checkAuthRate(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60000;
    const max = 10;
    let entry = authRateLimit.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      authRateLimit.set(ip, entry);
    }
    entry.count++;
    // Evict expired entries if map grows too large
    if (authRateLimit.size > 10000) {
      for (const [k, v] of authRateLimit) {
        if (now - v.windowStart > windowMs) authRateLimit.delete(k);
      }
    }
    return entry.count <= max;
  }

  router.post('/api/auth/login', async (req, res) => {
    if (!checkAuthRate(req)) return res.error(429, 'Too many login attempts');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const { username, password } = body;
    if (!username || !password) return res.error(400, 'Username and password required');

    const result = auth.authenticateUser(config.dataDir, username, password);
    if (!result.success) {
      audit.log({ actor: username, action: 'auth.login.failed', target: username, detail: 'Invalid credentials' });
      return res.error(401, 'Invalid credentials');
    }

    if (result.requiresPasswordChange) {
      const session = auth.createSession(result.user);
      res.setCookie('clawcc_session', session.token, { httpOnly: true, secure: config.httpsEnabled, sameSite: 'Lax', path: '/', maxAge: 3600 });
      return res.json(200, { success: true, requiresPasswordChange: true });
    }

    if (result.requiresMfa) {
      const session = auth.createSession(result.user, { mfaPending: true });
      res.setCookie('clawcc_session', session.token, { httpOnly: true, secure: config.httpsEnabled, sameSite: 'Lax', path: '/', maxAge: 300 });
      return res.json(200, { success: true, requiresMfa: true });
    }

    const session = auth.createSession(result.user);
    res.setCookie('clawcc_session', session.token, { httpOnly: true, secure: config.httpsEnabled, sameSite: 'Lax', path: '/', maxAge: 86400 });
    audit.log({ actor: username, action: 'auth.login.success', target: username });
    res.json(200, { success: true, user: { username: result.user.username, role: result.user.role } });
  });

  router.post('/api/auth/mfa/verify', async (req, res) => {
    // MFA verify uses raw session validation (allows mfaPending sessions)
    const token = req.cookies && req.cookies.clawcc_session;
    if (!token) return res.error(401, 'Not authenticated');
    const session = auth.validateSession(token);
    if (!session) return res.error(401, 'Invalid or expired session');
    if (!session.mfaPending) return res.error(400, 'No MFA verification pending');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const result = auth.verifyMfaLogin(config.dataDir, session.username, body.code);
    if (!result.success) return res.error(401, 'Invalid MFA code');
    // Upgrade session to fully authenticated (clears mfaPending, extends TTL)
    auth.upgradeSession(token);
    res.setCookie('clawcc_session', token, { httpOnly: true, secure: config.httpsEnabled, sameSite: 'Lax', path: '/', maxAge: 86400 });
    audit.log({ actor: session.username, action: 'auth.mfa.verified', target: session.username });
    res.json(200, { success: true });
  });

  router.post('/api/auth/mfa/setup', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const result = auth.enableMfa(config.dataDir, authResult.user.username);
    res.json(200, { success: true, secret: result.secret, qrUri: result.qrUri, recoveryCodes: result.recoveryCodes });
  });

  router.post('/api/auth/mfa/enable', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const valid = cryptoMod.verifyTOTP(authResult.user.mfaSecret, body.code);
    if (!valid) return res.error(400, 'Invalid code');
    res.json(200, { success: true });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies && req.cookies.clawcc_session;
    if (token) auth.destroySession(token);
    res.setCookie('clawcc_session', '', { httpOnly: true, secure: config.httpsEnabled, sameSite: 'Lax', path: '/', maxAge: 0 });
    res.json(200, { success: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const u = authResult.user;
    res.json(200, { success: true, user: { username: u.username, role: u.role, mfaEnabled: !!u.mfaEnabled } });
  });

  router.post('/api/auth/change-password', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.oldPassword || !body.newPassword) return res.error(400, 'Old and new passwords required');
    if (body.newPassword.length < 8) return res.error(400, 'Password must be at least 8 characters');
    try {
      auth.changePassword(authResult.user.username, body.oldPassword, body.newPassword);
    } catch (e) {
      return res.error(401, e.message === 'Invalid old password' ? 'Current password incorrect' : e.message);
    }
    audit.log({ actor: authResult.user.username, action: 'auth.password.changed', target: authResult.user.username });
    res.json(200, { success: true });
  });

  router.post('/api/auth/step-up', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.code) return res.error(400, 'MFA code required');
    const valid = auth.verifyMfaLogin(config.dataDir, authResult.user.username, body.code);
    if (!valid || !valid.success) return res.error(401, 'Invalid MFA code');
    auth.recordStepUp(req.cookies.clawcc_session);
    audit.log({ actor: authResult.user.username, action: 'auth.stepup', target: authResult.user.username });
    res.json(200, { success: true });
  });
}

module.exports = { registerAuthRoutes };
