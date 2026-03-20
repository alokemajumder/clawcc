'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED_AGENT_TYPES = new Set(['claude', 'codex', 'hermes', 'openclaw', 'zeroclaw', 'nemoclaw', 'openshell', 'nemotron', 'cursor', 'copilot', 'codeium', 'gemini', 'augment', 'kiro', 'amazonq', 'tabnine', 'continue', 'openhands', 'tabby', 'goose', 'opencode', 'cline', 'custom']);
const VALID_STATUSES = new Set(['active', 'idle', 'offline', 'error']);
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 5000;

function createAgentTracker(opts = {}) {
  const dataDir = opts.dataDir || null;
  const agentsDir = dataDir ? path.join(dataDir, 'agents') : null;
  const agents = new Map();
  let saveTimer = null;

  const soulsDir = agentsDir ? path.join(agentsDir, 'souls') : null;

  // Ensure agents directory exists
  if (agentsDir) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  if (soulsDir) {
    fs.mkdirSync(soulsDir, { recursive: true });
  }

  // Load persisted agents on init
  if (agentsDir) {
    const agentsFile = path.join(agentsDir, 'agents.json');
    try {
      const data = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [id, agent] of Object.entries(data)) {
          agents.set(id, agent);
        }
      }
    } catch { /* no persisted agents yet */ }
  }

  function scheduleSave() {
    if (!agentsDir) return;
    if (saveTimer) return; // already scheduled
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistAgents();
    }, DEBOUNCE_MS);
  }

  function persistAgents() {
    if (!agentsDir) return;
    const obj = {};
    for (const [id, agent] of agents) {
      obj[id] = agent;
    }
    const tmpPath = path.join(agentsDir, 'agents.json.tmp');
    const finalPath = path.join(agentsDir, 'agents.json');
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
      fs.renameSync(tmpPath, finalPath);
    } catch { /* ignore write errors */ }
  }

  function makeAgentInstance(agentData) {
    return {
      agentId: agentData.agentId || crypto.randomUUID(),
      nodeId: agentData.nodeId || 'unknown',
      type: agentData.type || 'custom',
      name: agentData.name || 'Unnamed Agent',
      version: agentData.version || '0.0.0',
      status: agentData.status || 'active',
      registeredAt: agentData.registeredAt || Date.now(),
      lastSeenAt: agentData.lastSeenAt || Date.now(),
      sessions: agentData.sessions || [],
      metrics: {
        totalSessions: 0,
        totalTokens: 0,
        totalCost: 0,
        errorCount: 0,
        avgResponseTime: 0,
        ...(agentData.metrics || {})
      },
      config: agentData.config || {},
      tags: agentData.tags || []
    };
  }

  function registerAgent(agentData) {
    if (!agentData || typeof agentData !== 'object') {
      throw new Error('Agent data is required');
    }
    if (!agentData.nodeId) {
      throw new Error('nodeId is required');
    }
    if (!agentData.type) {
      throw new Error('type is required');
    }
    if (!SUPPORTED_AGENT_TYPES.has(agentData.type)) {
      throw new Error('Unsupported agent type: ' + agentData.type + '. Supported: ' + [...SUPPORTED_AGENT_TYPES].join(', '));
    }

    const agentId = agentData.agentId || crypto.randomUUID();

    if (agents.has(agentId)) {
      throw new Error('Agent already registered: ' + agentId);
    }

    const agent = makeAgentInstance({ ...agentData, agentId });
    agents.set(agentId, agent);
    scheduleSave();
    return agentId;
  }

  function updateAgent(agentId, updates) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    // Only allow updating safe fields
    const allowedFields = ['name', 'version', 'status', 'config', 'tags'];
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        agent[key] = updates[key];
      }
    }
    if (updates.status && !VALID_STATUSES.has(updates.status)) {
      throw new Error('Invalid status: ' + updates.status);
    }
    scheduleSave();
    return agent;
  }

  function heartbeat(agentId, metrics) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    agent.lastSeenAt = Date.now();
    if (agent.status === 'offline') {
      agent.status = 'active';
    }

    if (metrics && typeof metrics === 'object') {
      if (typeof metrics.totalSessions === 'number') agent.metrics.totalSessions = metrics.totalSessions;
      if (typeof metrics.totalTokens === 'number') agent.metrics.totalTokens = metrics.totalTokens;
      if (typeof metrics.totalCost === 'number') agent.metrics.totalCost = metrics.totalCost;
      if (typeof metrics.errorCount === 'number') agent.metrics.errorCount = metrics.errorCount;
      if (typeof metrics.avgResponseTime === 'number') agent.metrics.avgResponseTime = metrics.avgResponseTime;
    }

    scheduleSave();
    return agent;
  }

  function getAgent(agentId) {
    return agents.get(agentId) || null;
  }

  function listAgents(filters = {}) {
    let result = [...agents.values()];
    if (filters.type) {
      result = result.filter(a => a.type === filters.type);
    }
    if (filters.nodeId) {
      result = result.filter(a => a.nodeId === filters.nodeId);
    }
    if (filters.status) {
      result = result.filter(a => a.status === filters.status);
    }
    return result;
  }

  function removeAgent(agentId) {
    const existed = agents.delete(agentId);
    if (!existed) throw new Error('Agent not found: ' + agentId);
    scheduleSave();
    return true;
  }

  function getAgentsByType(type) {
    return [...agents.values()].filter(a => a.type === type);
  }

  function getAgentsByNode(nodeId) {
    return [...agents.values()].filter(a => a.nodeId === nodeId);
  }

  function getFleetSummary() {
    const byType = {};
    const byStatus = {};
    let totalSessions = 0;
    let totalTokens = 0;
    let totalCost = 0;

    for (const agent of agents.values()) {
      byType[agent.type] = (byType[agent.type] || 0) + 1;
      byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
      totalSessions += agent.metrics.totalSessions || 0;
      totalTokens += agent.metrics.totalTokens || 0;
      totalCost += agent.metrics.totalCost || 0;
    }

    return {
      totalAgents: agents.size,
      byType,
      byStatus,
      totalSessions,
      totalTokens,
      totalCost
    };
  }

  function recordEvent(agentId, event) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    const record = {
      id: crypto.randomUUID(),
      agentId,
      timestamp: Date.now(),
      type: event.type || 'unknown',
      ...(event.payload ? { payload: event.payload } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {})
    };

    // Update agent metrics based on event type
    if (event.type === 'error') {
      agent.metrics.errorCount++;
    }
    if (event.type === 'completion' && typeof event.tokens === 'number') {
      agent.metrics.totalTokens += event.tokens;
    }
    if (event.sessionId && !agent.sessions.includes(event.sessionId)) {
      agent.sessions.push(event.sessionId);
      agent.metrics.totalSessions = agent.sessions.length;
    }

    // Persist to agent-specific JSONL
    if (agentsDir) {
      const filePath = path.join(agentsDir, 'events-' + agentId + '.jsonl');
      try {
        fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
      } catch { /* ignore */ }
    }

    scheduleSave();
    return record;
  }

  function getAgentTimeline(agentId, opts = {}) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    const limit = opts.limit || 100;
    const events = [];

    if (agentsDir) {
      const filePath = path.join(agentsDir, 'events-' + agentId + '.jsonl');
      try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          for (const line of content.split('\n')) {
            try {
              events.push(JSON.parse(line));
            } catch { /* skip bad lines */ }
          }
        }
      } catch { /* no events file yet */ }
    }

    // Return most recent events up to limit
    return events.slice(-limit);
  }

  function getAgentMetrics(agentId) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    const uptime = Date.now() - agent.registeredAt;
    return {
      ...agent.metrics,
      agentId,
      uptimeMs: uptime,
      status: agent.status,
      sessionsActive: agent.sessions.length
    };
  }

  function markStale(thresholdMs) {
    const threshold = thresholdMs || DEFAULT_STALE_THRESHOLD_MS;
    const now = Date.now();
    const marked = [];

    for (const agent of agents.values()) {
      if (agent.status !== 'offline' && (now - agent.lastSeenAt) > threshold) {
        agent.status = 'offline';
        marked.push(agent.agentId);
      }
    }

    if (marked.length > 0) {
      scheduleSave();
    }
    return marked;
  }

  function setSoul(agentId, soulContent) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);
    if (typeof soulContent !== 'string') throw new Error('SOUL content must be a string');
    agent.soul = soulContent;
    // Persist to disk
    if (soulsDir) {
      try {
        fs.writeFileSync(path.join(soulsDir, agentId + '.md'), soulContent, 'utf8');
      } catch { /* ignore write errors */ }
    }
    scheduleSave();
    return agent;
  }

  function getSoul(agentId) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);
    // Return from memory first
    if (agent.soul !== undefined) return agent.soul;
    // Fallback: try disk
    if (soulsDir) {
      try {
        const content = fs.readFileSync(path.join(soulsDir, agentId + '.md'), 'utf8');
        agent.soul = content;
        return content;
      } catch { /* no soul file */ }
    }
    return null;
  }

  function syncSoulsFromDisk() {
    if (!soulsDir) return [];
    const synced = [];
    try {
      const files = fs.readdirSync(soulsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const agentId = file.replace(/\.md$/, '');
        const agent = agents.get(agentId);
        if (agent) {
          try {
            agent.soul = fs.readFileSync(path.join(soulsDir, file), 'utf8');
            synced.push(agentId);
          } catch { /* skip unreadable files */ }
        }
      }
    } catch { /* no souls dir */ }
    return synced;
  }

  function exportSoul(agentId) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);
    return {
      agentId: agent.agentId,
      name: agent.name,
      type: agent.type,
      soul: agent.soul || null
    };
  }

  function destroy() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // Final persist
    persistAgents();
  }

  return {
    registerAgent,
    updateAgent,
    heartbeat,
    getAgent,
    listAgents,
    removeAgent,
    getAgentsByType,
    getAgentsByNode,
    getFleetSummary,
    recordEvent,
    getAgentTimeline,
    getAgentMetrics,
    markStale,
    setSoul,
    getSoul,
    syncSoulsFromDisk,
    exportSoul,
    destroy
  };
}

module.exports = { createAgentTracker, SUPPORTED_AGENT_TYPES };
