'use strict';

const { parseBody } = require('../middleware/security');
const { authenticate, requireStepUp } = require('../middleware/auth-middleware');

function registerGatewayRoutes(router, config, modules) {
  const { auth, audit, gateway } = modules;

  if (!gateway) return; // Gateway not enabled

  // GET /api/gateway/upstreams - List all upstreams with health (admin only)
  router.get('/api/gateway/upstreams', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const upstreams = gateway.listUpstreams();
    res.json(200, { success: true, upstreams });
  });

  // POST /api/gateway/upstreams - Add upstream (admin + step-up)
  router.post('/api/gateway/upstreams', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.id || !body.url || !body.name) return res.error(400, 'id, name, and url are required');
    try {
      const upstream = gateway.addUpstream(body);
      audit.log({ actor: authResult.user.username, action: 'gateway.upstream.added', target: body.id, detail: JSON.stringify({ name: body.name, url: body.url }) });
      res.json(201, { success: true, upstream });
    } catch (err) {
      res.error(400, err.message);
    }
  });

  // PUT /api/gateway/upstreams/:id - Update upstream (admin + step-up)
  router.put('/api/gateway/upstreams/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    try {
      const updated = gateway.updateUpstream(req.params.id, body);
      audit.log({ actor: authResult.user.username, action: 'gateway.upstream.updated', target: req.params.id, detail: JSON.stringify(body) });
      res.json(200, { success: true, upstream: updated });
    } catch (err) {
      res.error(err.message.includes('not found') ? 404 : 400, err.message);
    }
  });

  // DELETE /api/gateway/upstreams/:id - Remove upstream (admin + step-up)
  router.delete('/api/gateway/upstreams/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    try {
      gateway.removeUpstream(req.params.id);
      audit.log({ actor: authResult.user.username, action: 'gateway.upstream.removed', target: req.params.id });
      res.json(200, { success: true });
    } catch (err) {
      res.error(404, err.message);
    }
  });

  // GET /api/gateway/upstreams/:id/health - Get health for specific upstream
  router.get('/api/gateway/upstreams/:id/health', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const upstream = gateway.getUpstream(req.params.id);
    if (!upstream) return res.error(404, 'Upstream not found');
    res.json(200, { success: true, health: upstream.health });
  });

  // POST /api/gateway/proxy/:upstreamId/:proxyPath - Proxy a request to an upstream (admin only)
  // The proxyPath param captures a single segment; for deeper paths use query param ?path=/api/fleet/nodes
  router.post('/api/gateway/proxy/:upstreamId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const proxyPath = body.path || req.query.path || '/healthz';
    const method = body.method || 'GET';
    const proxyBody = body.body || null;
    try {
      const result = await gateway.proxyRequest(req.params.upstreamId, method, proxyPath, proxyBody);
      if (result.error) {
        return res.error(502, result.error);
      }
      audit.log({ actor: authResult.user.username, action: 'gateway.proxy', target: req.params.upstreamId, detail: method + ' ' + proxyPath });
      res.json(200, { success: true, upstream: req.params.upstreamId, result });
    } catch (err) {
      console.error('Gateway proxy error:', err);
      res.error(502, 'Proxy request failed');
    }
  });

  // GET /api/gateway/aggregate/nodes - Aggregate fleet nodes from all upstreams
  router.get('/api/gateway/aggregate/nodes', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    try {
      const aggregated = await gateway.aggregateRequest('GET', '/api/fleet/nodes', null);
      const allNodes = {};
      for (const r of aggregated.results) {
        const nodes = r.body && r.body.nodes ? r.body.nodes : {};
        for (const [nodeId, node] of Object.entries(nodes)) {
          allNodes[r.upstreamId + ':' + nodeId] = { ...node, _upstream: r.upstreamId };
        }
      }
      res.json(200, { success: true, nodes: allNodes, errors: aggregated.errors, total: aggregated.total });
    } catch (err) {
      console.error('Gateway aggregate error:', err);
      res.error(500, 'Aggregate request failed');
    }
  });

  // GET /api/gateway/aggregate/sessions - Aggregate sessions from all upstreams
  router.get('/api/gateway/aggregate/sessions', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    try {
      const aggregated = await gateway.aggregateRequest('GET', '/api/events/sessions', null);
      const allSessions = [];
      for (const r of aggregated.results) {
        const sessions = r.body && r.body.sessions ? r.body.sessions : [];
        for (const s of (Array.isArray(sessions) ? sessions : Object.values(sessions))) {
          allSessions.push({ ...s, _upstream: r.upstreamId });
        }
      }
      res.json(200, { success: true, sessions: allSessions, errors: aggregated.errors, total: aggregated.total });
    } catch (err) {
      res.error(500, 'Aggregate error: ' + (err.message || String(err)));
    }
  });

  // GET /api/gateway/aggregate/health - Aggregate health from all upstreams
  router.get('/api/gateway/aggregate/health', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const health = gateway.getHealth();
    res.json(200, { success: true, health });
  });

  // GET /api/gateway/status - Overall gateway status
  router.get('/api/gateway/status', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const health = gateway.getHealth();
    res.json(200, {
      success: true,
      gateway: {
        enabled: true,
        upstreams: health.total,
        healthy: health.healthy,
        unhealthy: health.unhealthy,
        unknown: health.unknown
      }
    });
  });
}

module.exports = { registerGatewayRoutes };
