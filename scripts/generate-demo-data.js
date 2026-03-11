#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(__dirname, '..', 'data');
const dirs = [
  'events', 'snapshots', 'audit', 'receipts', 'receipts/roots',
  'fleet', 'intents', 'users'
];

for (const d of dirs) {
  fs.mkdirSync(path.join(dataDir, d), { recursive: true });
}

const nodeIds = ['node-dev-alpha', 'node-dev-beta', 'node-staging-gamma'];
const providers = [
  'claude', 'codex', 'copilot', 'gemini', 'cursor', 'windsurf', 'amazon-q',
  'openclaw', 'zeroclaw', 'nemoclaw', 'goose', 'aider', 'cline', 'opencode'
];
const models = {
  claude: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-5-20251001'],
  codex: ['codex-mini', 'o4-mini', 'o3'],
  copilot: ['gpt-4o', 'gpt-4o-mini', 'copilot-agent-v2'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  cursor: ['cursor-fast', 'cursor-slow'],
  windsurf: ['windsurf-cascade', 'codeium-autocomplete'],
  'amazon-q': ['amazon-q-developer', 'amazon-q-transform'],
  openclaw: ['openclaw-v3', 'nanoclaw-v1', 'kimiclaw-v2', 'maxclaw-v1'],
  zeroclaw: ['zeroclaw-rust-v1'],
  nemoclaw: ['nemoclaw-enterprise', 'nemoclaw-lite'],
  goose: ['goose-default'],
  aider: ['aider-architect', 'aider-editor'],
  cline: ['cline-v3'],
  opencode: ['opencode-default']
};
const tools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'Agent'];
const severities = ['info', 'warning', 'error', 'critical'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSessionId() {
  return 'sess-' + crypto.randomBytes(8).toString('hex');
}

function generateEvent(ts, nodeId, sessionId, type, severity, payload) {
  return {
    ts: new Date(ts).toISOString(),
    nodeId,
    sessionId,
    type,
    severity: severity || 'info',
    payload: payload || {}
  };
}

const today = new Date();
const events = [];
const sessions = {};

for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
  const day = new Date(today);
  day.setDate(day.getDate() - dayOffset);
  const dateStr = day.toISOString().slice(0, 10);

  const sessionsPerDay = randomInt(3, 12);
  for (let s = 0; s < sessionsPerDay; s++) {
    const nodeId = randomChoice(nodeIds);
    const sessionId = generateSessionId();
    const provider = randomChoice(providers);
    const model = randomChoice(models[provider]);
    const startHour = randomInt(6, 22);
    const startMin = randomInt(0, 59);
    const startTs = new Date(day);
    startTs.setHours(startHour, startMin, 0, 0);
    const durationMin = randomInt(2, 120);

    sessions[sessionId] = {
      nodeId, provider, model, startedAt: startTs.toISOString(),
      status: dayOffset === 0 && s >= sessionsPerDay - 2 ? 'active' : 'ended',
      toolCalls: 0, errors: 0, tokens: 0, cost: 0
    };

    events.push(generateEvent(startTs.getTime(), nodeId, sessionId, 'session.started', 'info', {
      provider, model, goal: 'Development task #' + randomInt(100, 999)
    }));

    const steps = randomInt(5, 50);
    for (let step = 0; step < steps; step++) {
      const stepTs = startTs.getTime() + (durationMin * 60000 * step / steps);
      const tool = randomChoice(tools);

      events.push(generateEvent(stepTs + 1000, nodeId, sessionId, 'message.user', 'info', {
        preview: 'User message step ' + (step + 1)
      }));

      events.push(generateEvent(stepTs + 2000, nodeId, sessionId, 'tool.call', 'info', {
        tool, args: { file: '/src/example.js' }
      }));
      sessions[sessionId].toolCalls++;

      if (Math.random() < 0.05) {
        events.push(generateEvent(stepTs + 3000, nodeId, sessionId, 'tool.error', 'error', {
          tool, error: 'Simulated error'
        }));
        sessions[sessionId].errors++;
      } else {
        events.push(generateEvent(stepTs + 3000, nodeId, sessionId, 'tool.result', 'info', {
          tool, success: true
        }));
      }

      events.push(generateEvent(stepTs + 4000, nodeId, sessionId, 'message.agent', 'info', {
        preview: 'Agent response step ' + (step + 1)
      }));

      const inputTokens = randomInt(100, 5000);
      const outputTokens = randomInt(50, 2000);
      const costPer1k = provider === 'claude' ? 0.003 : 0.001;
      const cost = ((inputTokens + outputTokens) / 1000) * costPer1k;
      sessions[sessionId].tokens += inputTokens + outputTokens;
      sessions[sessionId].cost += cost;

      events.push(generateEvent(stepTs + 5000, nodeId, sessionId, 'provider.usage', 'info', {
        provider, model, inputTokens, outputTokens,
        cost: Math.round(cost * 10000) / 10000
      }));
    }

    if (sessions[sessionId].status === 'ended') {
      const endTs = startTs.getTime() + durationMin * 60000;
      events.push(generateEvent(endTs, nodeId, sessionId, 'session.ended', 'info', {
        duration: durationMin * 60, toolCalls: sessions[sessionId].toolCalls
      }));
    }

    if (Math.random() < 0.08) {
      const twTs = startTs.getTime() + randomInt(60000, durationMin * 60000);
      events.push(generateEvent(twTs, nodeId, sessionId, 'tripwire.triggered', 'critical', {
        tripwireId: 'tw-secret-env',
        target: '/tmp/clawcc-canary/.env.production',
        description: 'Canary environment file accessed'
      }));
    }

    if (Math.random() < 0.15) {
      const pvTs = startTs.getTime() + randomInt(60000, durationMin * 60000);
      events.push(generateEvent(pvTs, nodeId, sessionId, 'policy.violation', 'warning', {
        ruleId: 'cost-warn',
        policyId: 'default-baseline',
        enforcement: 'warn',
        reason: 'Session cost exceeded threshold'
      }));
    }
  }

  for (const nodeId of nodeIds) {
    for (let h = 0; h < 24; h++) {
      const hbTs = new Date(day);
      hbTs.setHours(h, randomInt(0, 59), 0, 0);
      events.push(generateEvent(hbTs.getTime(), nodeId, null, 'node.heartbeat', 'info', {
        cpu: randomInt(5, 85),
        ram: randomInt(30, 90),
        disk: randomInt(20, 75),
        uptime: randomInt(3600, 864000)
      }));
    }
  }
}

events.sort((a, b) => new Date(a.ts) - new Date(b.ts));

const byDate = {};
for (const event of events) {
  const date = event.ts.slice(0, 10);
  if (!byDate[date]) byDate[date] = [];
  byDate[date].push(event);
}

for (const [date, dayEvents] of Object.entries(byDate)) {
  const filePath = path.join(dataDir, 'events', date + '.jsonl');
  const lines = dayEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines);
}

const sessionsSnapshot = {};
for (const [id, s] of Object.entries(sessions)) {
  sessionsSnapshot[id] = {
    ...s,
    cost: Math.round(s.cost * 10000) / 10000,
    lastActivity: s.startedAt,
    driftScore: randomInt(0, 60)
  };
}
fs.writeFileSync(path.join(dataDir, 'snapshots', 'sessions.json'), JSON.stringify({ sessions: sessionsSnapshot }, null, 2));

const usageSnapshot = { providers: {}, lifetime: { totalCost: 0, totalTokens: 0 } };
for (const [id, s] of Object.entries(sessions)) {
  if (!usageSnapshot.providers[s.provider]) {
    usageSnapshot.providers[s.provider] = { models: {}, totalCost: 0 };
  }
  const prov = usageSnapshot.providers[s.provider];
  if (!prov.models[s.model]) {
    prov.models[s.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastUsed: s.startedAt };
  }
  const m = prov.models[s.model];
  m.requests += s.toolCalls;
  m.inputTokens += Math.floor(s.tokens * 0.6);
  m.outputTokens += Math.floor(s.tokens * 0.4);
  m.cost += s.cost;
  m.lastUsed = s.startedAt;
  prov.totalCost += s.cost;
  usageSnapshot.lifetime.totalCost += s.cost;
  usageSnapshot.lifetime.totalTokens += s.tokens;
}
fs.writeFileSync(path.join(dataDir, 'snapshots', 'usage.json'), JSON.stringify(usageSnapshot, null, 2));

const healthSnapshot = { nodes: {} };
for (const nodeId of nodeIds) {
  healthSnapshot.nodes[nodeId] = {
    status: 'online',
    lastHeartbeat: new Date().toISOString(),
    cpu: randomInt(10, 60),
    ram: randomInt(40, 80),
    disk: randomInt(25, 65),
    os: randomChoice(['darwin', 'linux']),
    hostname: nodeId.replace('node-', '') + '.tail12345.ts.net',
    tailscaleIp: '100.64.' + randomInt(1, 254) + '.' + randomInt(1, 254),
    tags: nodeId.includes('staging') ? ['staging'] : ['dev'],
    sessions: Object.entries(sessions).filter(([, s]) => s.nodeId === nodeId && s.status === 'active').length
  };
}
fs.writeFileSync(path.join(dataDir, 'snapshots', 'health.json'), JSON.stringify(healthSnapshot, null, 2));

const topologySnapshot = {
  nodes: nodeIds.map(id => ({
    id,
    type: 'node',
    label: id,
    status: 'online'
  })).concat(
    tools.map(t => ({ id: 'tool-' + t, type: 'tool', label: t })),
    [
      { id: 'repo-main', type: 'repo', label: 'main-repo' },
      { id: 'svc-api', type: 'service', label: 'API Server' },
      { id: 'cron-backup', type: 'cron', label: 'Daily Backup' }
    ]
  ),
  edges: nodeIds.flatMap(id =>
    tools.slice(0, randomInt(3, tools.length)).map(t => ({
      source: id,
      target: 'tool-' + t,
      weight: randomInt(1, 100),
      type: 'uses'
    }))
  ).concat(
    nodeIds.map(id => ({ source: id, target: 'repo-main', weight: randomInt(10, 50), type: 'accesses' })),
    [{ source: 'node-staging-gamma', target: 'svc-api', weight: 30, type: 'calls' }]
  )
};
fs.writeFileSync(path.join(dataDir, 'snapshots', 'topology.json'), JSON.stringify(topologySnapshot, null, 2));

const fleetNodes = {};
for (const nodeId of nodeIds) {
  fleetNodes[nodeId] = {
    nodeId,
    hostname: healthSnapshot.nodes[nodeId].hostname,
    os: healthSnapshot.nodes[nodeId].os,
    tags: healthSnapshot.nodes[nodeId].tags,
    tailscaleIp: healthSnapshot.nodes[nodeId].tailscaleIp,
    enrolledAt: new Date(today.getTime() - randomInt(7, 30) * 86400000).toISOString(),
    lastSeen: new Date().toISOString(),
    status: 'online'
  };
}
fs.writeFileSync(path.join(dataDir, 'fleet', 'nodes.json'), JSON.stringify(fleetNodes, null, 2));

const intentExample = {
  sessionId: Object.keys(sessions)[0],
  goal: 'Implement user authentication module',
  constraints: ['No external dependencies', 'Use PBKDF2 for password hashing'],
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  allowedPaths: ['/src/', '/test/', '/docs/'],
  allowedEndpoints: [],
  maxBudget: 10.0,
  maxDuration: 7200,
  createdAt: new Date().toISOString()
};
fs.writeFileSync(
  path.join(dataDir, 'intents', Object.keys(sessions)[0] + '.json'),
  JSON.stringify(intentExample, null, 2)
);

const auditEntries = [];
const auditActions = ['user.login', 'session.kill', 'policy.update', 'node.enroll', 'skill.deploy', 'evidence.export'];
for (let i = 0; i < 50; i++) {
  const ts = new Date(today.getTime() - randomInt(0, 7) * 86400000 - randomInt(0, 86400000));
  auditEntries.push({
    ts: ts.toISOString(),
    entryId: crypto.randomUUID(),
    seq: i,
    actor: randomChoice(['admin', 'operator1', 'viewer1']),
    action: randomChoice(auditActions),
    target: randomChoice([...nodeIds, ...Object.keys(sessions).slice(0, 5)]),
    detail: 'Demo audit entry',
    previousHash: i > 0 ? crypto.createHash('sha256').update(String(i - 1)).digest('hex') : '0'.repeat(64)
  });
}

const auditByDate = {};
for (const entry of auditEntries) {
  const date = entry.ts.slice(0, 10);
  if (!auditByDate[date]) auditByDate[date] = [];
  auditByDate[date].push(entry);
}
for (const [date, entries] of Object.entries(auditByDate)) {
  fs.writeFileSync(
    path.join(dataDir, 'audit', date + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  );
}

console.log('Demo data generated:');
console.log('  Events:  ', events.length, 'events across', Object.keys(byDate).length, 'days');
console.log('  Sessions:', Object.keys(sessions).length);
console.log('  Nodes:   ', nodeIds.length);
console.log('  Audit:   ', auditEntries.length, 'entries');
console.log('  Data dir:', dataDir);
