'use strict';

const { parseBody } = require('../middleware/security');
const { authenticate, requireStepUp } = require('../middleware/auth-middleware');

function registerSecurityRoutes(router, config, modules) {
  const { auth, audit, securityProfiles, secretScanner } = modules;

  // --- Security Profile Endpoints ---

  // GET /api/security/profile - Get active profile (viewer+)
  router.get('/api/security/profile', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const profile = securityProfiles.getActiveProfile();
    res.json(200, { success: true, profile });
  });

  // PUT /api/security/profile - Set active profile (admin + step-up)
  router.put('/api/security/profile', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.profileId) return res.error(400, 'profileId required');
    try {
      const profile = securityProfiles.setActiveProfile(body.profileId);
      audit.log({ actor: authResult.user.username, action: 'security.profile.changed', target: body.profileId });
      res.json(200, { success: true, profile });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // GET /api/security/profiles - List all profiles (viewer+)
  router.get('/api/security/profiles', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const profiles = securityProfiles.listProfiles();
    res.json(200, { success: true, profiles });
  });

  // POST /api/security/profiles - Create custom profile (admin)
  router.post('/api/security/profiles', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    try {
      const profile = securityProfiles.createCustomProfile(body);
      audit.log({ actor: authResult.user.username, action: 'security.profile.created', target: profile.id });
      res.json(200, { success: true, profile });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // PUT /api/security/profiles/:id - Update custom profile (admin)
  router.put('/api/security/profiles/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    try {
      const profile = securityProfiles.updateCustomProfile(req.params.id, body);
      audit.log({ actor: authResult.user.username, action: 'security.profile.updated', target: req.params.id });
      res.json(200, { success: true, profile });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // DELETE /api/security/profiles/:id - Delete custom profile (admin)
  router.delete('/api/security/profiles/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    try {
      securityProfiles.deleteCustomProfile(req.params.id);
      audit.log({ actor: authResult.user.username, action: 'security.profile.deleted', target: req.params.id });
      res.json(200, { success: true });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // GET /api/security/events - List security events (auditor+)
  router.get('/api/security/events', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'audit:read')) return res.error(403, 'Insufficient permissions');
    const filters = {};
    if (req.query.type) filters.type = req.query.type;
    if (req.query.limit) filters.limit = parseInt(req.query.limit, 10);
    const events = securityProfiles.getSecurityEvents(filters);
    res.json(200, { success: true, events });
  });

  // GET /api/security/stats - Security statistics (viewer+)
  router.get('/api/security/stats', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const stats = securityProfiles.getSecurityStats();
    res.json(200, { success: true, stats });
  });

  // --- Secret Scanner Endpoints ---

  // POST /api/security/scan - Scan text for secrets (operator+)
  router.post('/api/security/scan', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (typeof body.text !== 'string') return res.error(400, 'text field required');
    const findings = secretScanner.scan(body.text);
    res.json(200, { success: true, findings, count: findings.length });
  });

  // POST /api/security/scan/object - Scan object for secrets (operator+)
  router.post('/api/security/scan/object', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.data || typeof body.data !== 'object') return res.error(400, 'data field required (object)');
    const findings = secretScanner.scanObject(body.data);
    res.json(200, { success: true, findings, count: findings.length });
  });

  // GET /api/security/patterns - List detection patterns (viewer+)
  router.get('/api/security/patterns', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const patterns = secretScanner.getPatterns();
    res.json(200, { success: true, patterns });
  });

  // POST /api/security/patterns - Add custom pattern (admin)
  router.post('/api/security/patterns', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    try {
      // Convert regex string to RegExp
      if (body.regex && typeof body.regex === 'string') {
        try {
          body.regex = new RegExp(body.regex, body.flags || '');
        } catch (regexErr) {
          return res.error(400, 'Invalid regex pattern: ' + regexErr.message);
        }
      }
      const pattern = secretScanner.addPattern(body);
      audit.log({ actor: authResult.user.username, action: 'security.pattern.added', target: body.name });
      res.json(200, { success: true, pattern });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // DELETE /api/security/patterns/:name - Remove custom pattern (admin)
  router.delete('/api/security/patterns/:name', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    try {
      secretScanner.removePattern(req.params.name);
      audit.log({ actor: authResult.user.username, action: 'security.pattern.removed', target: req.params.name });
      res.json(200, { success: true });
    } catch (err) {
      return res.error(400, err.message);
    }
  });

  // POST /api/security/mask - Mask secrets in text (operator+)
  router.post('/api/security/mask', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (typeof body.text !== 'string') return res.error(400, 'text field required');
    const masked = secretScanner.maskSecrets(body.text);
    res.json(200, { success: true, masked });
  });
}

module.exports = { registerSecurityRoutes };
