'use strict';
const crypto = require('crypto');
const { authenticate, requireStepUp } = require('../middleware/auth-middleware');

function registerKillSwitchRoutes(router, config, modules) {
  const { auth, audit, events, receipts } = modules;

  async function performKill(type, target, user, res) {
    const killId = crypto.randomUUID();
    const ts = new Date().toISOString();

    audit.log({ actor: user.username, action: 'kill.' + type, target, detail: 'Kill switch activated', reason: 'Manual kill by ' + user.username });

    events.ingest({ ts, nodeId: type === 'node' ? target : null, sessionId: type === 'session' ? target : null, type: 'session.ended', severity: 'critical', payload: { reason: 'kill-switch', killId, killedBy: user.username, scope: type } });

    let bundle = null;
    try { bundle = receipts.exportBundle(config.dataDir, type === 'session' ? target : null, { killId }); } catch {}

    res.json(200, { success: true, killId, type, target, evidenceBundle: bundle ? bundle.bundleId || killId : killId, timestamp: ts });
  }

  router.post('/api/kill/session/:sessionId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    await performKill('session', req.params.sessionId, authResult.user, res);
  });

  router.post('/api/kill/node/:nodeId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    await performKill('node', req.params.nodeId, authResult.user, res);
  });

  router.post('/api/kill/global', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    await performKill('global', 'all', authResult.user, res);
  });
}

module.exports = { registerKillSwitchRoutes };
