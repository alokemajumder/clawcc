'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const MAX_SESSIONS = 50000; // cap in-memory sessions to prevent OOM
const SESSION_EVICT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // evict sessions older than 30 days

function evictOldSessions(sessions) {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_SESSIONS) return;
  const cutoff = new Date(Date.now() - SESSION_EVICT_AGE_MS).toISOString();
  for (const key of keys) {
    if (sessions[key].status === 'ended' && sessions[key].lastActivity < cutoff) {
      delete sessions[key];
    }
    if (Object.keys(sessions).length <= MAX_SESSIONS) break;
  }
}

function rebuild(dataDir) {
  const eventsDir = path.join(dataDir, 'events');
  const snapshotsDir = path.join(dataDir, 'snapshots');
  ensureDir(snapshotsDir);

  const sessions = {};
  const usage = { providers: {}, lifetime: { totalCost: 0, totalTokens: 0 } };
  const health = { nodes: {} };
  const topology = { nodes: [], edges: [] };
  const nodeSet = new Set();
  const toolSet = new Set();
  const edgeMap = new Map();

  try {
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl')).sort();

    for (const file of files) {
      const content = fs.readFileSync(path.join(eventsDir, file), 'utf8').trim();
      if (!content) continue;

      for (const line of content.split('\n')) {
        try {
          const event = JSON.parse(line);
          processEvent(event, sessions, usage, health, nodeSet, toolSet, edgeMap);
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* no events yet */ }

  evictOldSessions(sessions);

  for (const nodeId of nodeSet) {
    topology.nodes.push({ id: nodeId, type: 'node', label: nodeId, status: health.nodes[nodeId] ? health.nodes[nodeId].status : 'unknown' });
  }
  for (const tool of toolSet) {
    topology.nodes.push({ id: 'tool-' + tool, type: 'tool', label: tool });
  }
  for (const [key, edge] of edgeMap) {
    topology.edges.push(edge);
  }

  fs.writeFileSync(path.join(snapshotsDir, 'sessions.json'), JSON.stringify({ sessions }, null, 2));
  fs.writeFileSync(path.join(snapshotsDir, 'usage.json'), JSON.stringify(usage, null, 2));
  fs.writeFileSync(path.join(snapshotsDir, 'health.json'), JSON.stringify(health, null, 2));
  fs.writeFileSync(path.join(snapshotsDir, 'topology.json'), JSON.stringify(topology, null, 2));
}

function processEvent(event, sessions, usage, health, nodeSet, toolSet, edgeMap) {
  if (event.nodeId) nodeSet.add(event.nodeId);
  const eventTs = event.ts || event.timestamp;

  switch (event.type) {
    case 'session.started':
      sessions[event.sessionId] = {
        nodeId: event.nodeId, status: 'active', startedAt: eventTs,
        lastActivity: eventTs, provider: event.payload?.provider || '',
        model: event.payload?.model || '', toolCalls: 0, errors: 0,
        tokens: 0, cost: 0, driftScore: 0
      };
      break;

    case 'session.ended':
      if (sessions[event.sessionId]) {
        sessions[event.sessionId].status = 'ended';
        sessions[event.sessionId].lastActivity = eventTs;
      }
      break;

    case 'session.error':
      if (sessions[event.sessionId]) {
        sessions[event.sessionId].errors++;
        sessions[event.sessionId].lastActivity = eventTs;
      }
      break;

    case 'tool.call':
      if (sessions[event.sessionId]) {
        sessions[event.sessionId].toolCalls++;
        sessions[event.sessionId].lastActivity = eventTs;
      }
      if (event.payload?.tool) {
        toolSet.add(event.payload.tool);
        if (event.nodeId) {
          const key = event.nodeId + '->' + event.payload.tool;
          const existing = edgeMap.get(key);
          if (existing) existing.weight++;
          else edgeMap.set(key, { source: event.nodeId, target: 'tool-' + event.payload.tool, weight: 1, type: 'uses' });
        }
      }
      break;

    case 'tool.error':
      if (sessions[event.sessionId]) {
        sessions[event.sessionId].errors++;
        sessions[event.sessionId].lastActivity = eventTs;
      }
      break;

    case 'provider.usage':
      if (event.payload) {
        const p = event.payload;
        if (!usage.providers[p.provider]) {
          usage.providers[p.provider] = { models: {}, totalCost: 0 };
        }
        const prov = usage.providers[p.provider];
        if (!prov.models[p.model]) {
          prov.models[p.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastUsed: eventTs };
        }
        const m = prov.models[p.model];
        m.requests++;
        m.inputTokens += p.inputTokens || 0;
        m.outputTokens += p.outputTokens || 0;
        m.cost += p.cost || 0;
        m.lastUsed = eventTs;
        prov.totalCost += p.cost || 0;
        usage.lifetime.totalCost += p.cost || 0;
        usage.lifetime.totalTokens += (p.inputTokens || 0) + (p.outputTokens || 0);

        if (sessions[event.sessionId]) {
          sessions[event.sessionId].tokens += (p.inputTokens || 0) + (p.outputTokens || 0);
          sessions[event.sessionId].cost += p.cost || 0;
        }
      }
      break;

    case 'node.heartbeat':
      if (event.nodeId && event.payload) {
        health.nodes[event.nodeId] = {
          status: 'online',
          lastHeartbeat: eventTs,
          cpu: event.payload.cpu ?? event.payload.health?.cpu?.usage,
          ram: event.payload.ram ?? event.payload.health?.ram?.percent,
          disk: event.payload.disk ?? event.payload.health?.disk?.percent,
          os: event.payload.os || health.nodes[event.nodeId]?.os,
          hostname: event.payload.hostname || health.nodes[event.nodeId]?.hostname,
          tailscaleIp: event.payload.tailscaleIp || health.nodes[event.nodeId]?.tailscaleIp
        };
      }
      break;

    case 'node.registered':
      if (event.nodeId) {
        if (!health.nodes[event.nodeId]) health.nodes[event.nodeId] = {};
        Object.assign(health.nodes[event.nodeId], {
          status: 'online',
          hostname: event.payload?.hostname,
          os: event.payload?.os,
          tags: event.payload?.tags
        });
      }
      break;
  }
}

function update(dataDir, event) {
  if (!event || !event.type) return;
  const snapshotsDir = path.join(dataDir, 'snapshots');
  ensureDir(snapshotsDir);

  const snapFiles = ['sessions', 'usage', 'health', 'topology'];
  const data = {};
  for (const name of snapFiles) {
    try {
      data[name] = JSON.parse(fs.readFileSync(path.join(snapshotsDir, name + '.json'), 'utf8'));
    } catch {
      data[name] = name === 'sessions' ? { sessions: {} } :
                    name === 'usage' ? { providers: {}, lifetime: { totalCost: 0, totalTokens: 0 } } :
                    name === 'health' ? { nodes: {} } :
                    { nodes: [], edges: [] };
    }
  }

  const nodeSet = new Set(data.topology.nodes.filter(n => n.type === 'node').map(n => n.id));
  const toolSet = new Set(data.topology.nodes.filter(n => n.type === 'tool').map(n => n.label));
  const edgeMap = new Map(data.topology.edges.map(e => [e.source + '->' + e.target, e]));

  const sessionsObj = (data.sessions && data.sessions.sessions) ? data.sessions.sessions : (data.sessions || {});
  processEvent(event, sessionsObj, data.usage, data.health, nodeSet, toolSet, edgeMap);

  // Only write changed snapshots based on event type
  const eventTypeToSnap = {
    'session.started': ['sessions'], 'session.ended': ['sessions'], 'session.error': ['sessions'],
    'tool.call': ['sessions', 'topology'], 'tool.error': ['sessions'],
    'provider.usage': ['sessions', 'usage'],
    'node.heartbeat': ['health'], 'node.registered': ['health']
  };
  const toWrite = eventTypeToSnap[event.type] || [];
  for (const name of toWrite) {
    try {
      fs.writeFileSync(path.join(snapshotsDir, name + '.json'), JSON.stringify(data[name], null, 2));
    } catch { /* ignore write errors */ }
  }
}

function load(dataDir, snapshotName) {
  const filePath = path.join(dataDir, 'snapshots', snapshotName + '.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { rebuild, update, load };
