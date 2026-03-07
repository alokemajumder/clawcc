'use strict';
const fs = require('fs');
const path = require('path');
const { parseBody } = require('../middleware/security');
const { authenticate, verifyNodeSignature } = require('../middleware/auth-middleware');

function registerFleetRoutes(router, config, modules) {
  const { auth, audit, events, index, snapshots, crypto: cryptoMod } = modules;
  const pendingCommands = new Map(); // nodeId -> commands[]
  const PENDING_COMMANDS_MAX = 500; // max total commands across all nodes

  function loadFleetNodes() {
    return index ? index.getFleetNodes(config.dataDir) : {};
  }

  function saveFleetNodes(nodes) {
    if (index) return index.saveFleetNodes(config.dataDir, nodes);
    const dir = path.join(config.dataDir, 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, 'nodes.json.tmp');
    const finalPath = path.join(dir, 'nodes.json');
    fs.writeFile(tmpPath, JSON.stringify(nodes, null, 2), (err) => {
      if (!err) try { fs.renameSync(tmpPath, finalPath); } catch {}
    });
  }

  router.post('/api/fleet/register', async (req, res) => {
    const sigResult = verifyNodeSignature(req, config, cryptoMod);
    if (!sigResult.valid) return res.error(401, 'Not authenticated: ' + sigResult.error);
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const { nodeId, hostname, os, tags, tailscaleIp } = body;
    if (!nodeId || !hostname) return res.error(400, 'nodeId and hostname required');

    const nodes = loadFleetNodes();
    nodes[nodeId] = {
      nodeId, hostname, os: os || process.platform, tags: tags || [],
      tailscaleIp: tailscaleIp || null,
      enrolledAt: nodes[nodeId] ? nodes[nodeId].enrolledAt : new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'online'
    };
    saveFleetNodes(nodes);
    audit.log({ actor: 'system', action: 'node.enrolled', target: nodeId, detail: hostname });
    events.ingest({ ts: new Date().toISOString(), nodeId, sessionId: null, type: 'node.registered', severity: 'info', payload: { hostname, os, tags } });
    res.json(200, { success: true, enrolled: true });
  });

  router.post('/api/fleet/heartbeat', async (req, res) => {
    const sigResult = verifyNodeSignature(req, config, cryptoMod);
    if (!sigResult.valid) return res.error(401, 'Not authenticated: ' + sigResult.error);
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const { nodeId, health, sessions, timestamp } = body;
    if (!nodeId) return res.error(400, 'nodeId required');

    const nodes = loadFleetNodes();
    if (nodes[nodeId]) {
      nodes[nodeId].lastSeen = new Date().toISOString();
      nodes[nodeId].status = 'online';
      saveFleetNodes(nodes);
    }

    events.ingest({ ts: new Date().toISOString(), nodeId, sessionId: null, type: 'node.heartbeat', severity: 'info', payload: { health, sessions } });
    snapshots.update(config.dataDir, { type: 'node.heartbeat', nodeId, payload: { health } });

    const commands = pendingCommands.get(nodeId) || [];
    pendingCommands.set(nodeId, []);
    res.json(200, { success: true, commands });
  });

  router.get('/api/fleet/nodes', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const nodes = loadFleetNodes();
    // Mark nodes as offline if heartbeat timeout exceeded
    const timeout = config.fleet ? config.fleet.heartbeatTimeoutMs || 60000 : 60000;
    const now = Date.now();
    for (const node of Object.values(nodes)) {
      if (now - new Date(node.lastSeen).getTime() > timeout) node.status = 'offline';
    }
    res.json(200, { success: true, nodes });
  });

  router.get('/api/fleet/nodes/:nodeId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const nodes = loadFleetNodes();
    const node = nodes[req.params.nodeId];
    if (!node) return res.error(404, 'Node not found');
    res.json(200, { success: true, node });
  });

  router.get('/api/fleet/nodes/:nodeId/sessions', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const sessData = snapshots.load(config.dataDir, 'sessions');
    const nodeSessions = {};
    if (sessData && sessData.sessions) {
      for (const [id, s] of Object.entries(sessData.sessions)) {
        if (s.nodeId === req.params.nodeId) nodeSessions[id] = s;
      }
    }
    res.json(200, { success: true, sessions: nodeSessions });
  });

  router.post('/api/fleet/nodes/:nodeId/action', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const commandId = require('crypto').randomUUID();
    const command = { id: commandId, action: body.action, args: body.args, requestedBy: authResult.user.username, ts: new Date().toISOString() };
    const cmds = pendingCommands.get(req.params.nodeId) || [];
    // Cap per-node command queue at 50
    if (cmds.length >= 50) return res.error(429, 'Too many pending commands for this node');
    cmds.push(command);
    pendingCommands.set(req.params.nodeId, cmds);
    // Evict nodes with no pending commands if map is too large
    if (pendingCommands.size > PENDING_COMMANDS_MAX) {
      for (const [nid, ncmds] of pendingCommands) {
        if (ncmds.length === 0) pendingCommands.delete(nid);
      }
    }
    audit.log({ actor: authResult.user.username, action: 'node.action', target: req.params.nodeId, detail: JSON.stringify(body) });
    res.json(200, { success: true, queued: true, commandId });
  });

  router.delete('/api/fleet/nodes/:nodeId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (authResult.user.role !== 'ADMIN') return res.error(403, 'Admin required');
    const nodes = loadFleetNodes();
    delete nodes[req.params.nodeId];
    saveFleetNodes(nodes);
    audit.log({ actor: authResult.user.username, action: 'node.removed', target: req.params.nodeId });
    res.json(200, { success: true });
  });

  router.get('/api/fleet/nodes/:nodeId/blast-radius', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const nodeId = req.params.nodeId;
    const nodes = loadFleetNodes();
    if (!nodes[nodeId]) return res.error(404, 'Node not found');
    const sessData = snapshots.load(config.dataDir, 'sessions');
    const sessions = sessData ? sessData.sessions || {} : {};
    const activeSessions = [];
    let totalTokensAtRisk = 0;
    let totalCostAtRisk = 0;
    for (const [id, s] of Object.entries(sessions)) {
      if (s.nodeId === nodeId && s.status === 'active') {
        activeSessions.push({ sessionId: id, ...s });
        totalTokensAtRisk += s.tokens || 0;
        totalCostAtRisk += s.cost || 0;
      }
    }
    const topo = snapshots.load(config.dataDir, 'topology') || { nodes: [], edges: [] };
    const affectedTools = [];
    const connectedNodes = [];
    for (const edge of (topo.edges || [])) {
      if (edge.source === nodeId) {
        if (edge.target && !connectedNodes.includes(edge.target)) connectedNodes.push(edge.target);
        if (edge.label || edge.tool) affectedTools.push(edge.label || edge.tool);
      }
      if (edge.target === nodeId) {
        if (edge.source && !connectedNodes.includes(edge.source)) connectedNodes.push(edge.source);
      }
    }
    res.json(200, { success: true, blastRadius: { nodeId, activeSessions, affectedTools, connectedNodes, totalTokensAtRisk, totalCostAtRisk } });
  });

  router.get('/api/fleet/topology', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const topo = snapshots.load(config.dataDir, 'topology');
    res.json(200, { success: true, topology: topo || { nodes: [], edges: [] } });
  });
}

module.exports = { registerFleetRoutes };
