#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { discoverSessions, discoverMemory, discoverGitActivity, discoverCronJobs, discoverTailscale } = require('./lib/discovery');
const { collectHealth, startHealthCollection } = require('./lib/telemetry');
const { init: initSpool } = require('./lib/spool');
const { loadAllowlists, validateAction, executeAction } = require('./lib/sandbox');

// Load config
const configPaths = [
  path.join(process.cwd(), 'node-agent.config.json'),
  path.join(os.homedir(), '.config', 'clawcc', 'node-agent.config.json'),
  path.join(__dirname, '..', 'config', 'node-agent.config.example.json')
];

let config = {};
for (const cp of configPaths) {
  try {
    config = JSON.parse(fs.readFileSync(cp, 'utf8'));
    console.log('Loaded config from:', cp);
    break;
  } catch { /* try next */ }
}

// Generate nodeId if not set
if (!config.nodeId) {
  config.nodeId = os.hostname().replace(/[^a-zA-Z0-9-]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
  console.log('Generated nodeId:', config.nodeId);
}

const controlPlaneUrl = config.controlPlaneUrl || 'http://localhost:3400';
const nodeSecret = config.nodeSecret || 'default-secret';
const heartbeatIntervalMs = config.heartbeatIntervalMs || 15000;
const telemetryIntervalMs = config.telemetryIntervalMs || 5000;
const discoveryPaths = config.discoveryPaths || [
  // Paid / Big Provider agents
  '~/.claude', '~/.codex', '~/.copilot', '~/.cursor',
  '~/.codeium', '~/.gemini', '~/.augment', '~/.kiro',
  '~/.aws/amazonq', '~/.config/TabNine',
  // Open Source agents
  '~/.openclaw', '~/.zeroclaw', '~/.nanobot', '~/.nemoclaw',
  '~/.continue', '~/.openhands', '~/.tabby',
  '~/.config/goose', '~/.config/opencode',
  '~/Documents/Cline'
];
const dataDir = (config.dataDir || './node-data').replace(/^~/, os.homedir());
const spoolDir = (config.spoolDir || path.join(dataDir, 'spool')).replace(/^~/, os.homedir());
const allowlistsDir = (config.allowlistsDir || '../allowlists').replace(/^~/, os.homedir());
const maxResponseSize = config.maxResponseSize || 1048576; // 1MB response limit

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(spoolDir, { recursive: true });

const spooler = initSpool(spoolDir);
const healthCollector = startHealthCollection(telemetryIntervalMs);

let controlPlaneReachable = false;
let backoffMs = 0;
const maxBackoffMs = 300000; // 5 minutes max backoff

function resetBackoff() {
  backoffMs = 0;
}

function increaseBackoff() {
  if (backoffMs === 0) backoffMs = 1000;
  else backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
}

function signedRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, controlPlaneUrl);
    const data = body ? JSON.stringify(body) : '';
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const hmac = crypto.createHmac('sha256', nodeSecret);
    hmac.update(method + '\n' + url.pathname + '\n' + timestamp + '\n' + data);
    const signature = hmac.digest('hex');

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'X-ClawCC-NodeId': config.nodeId,
        'X-ClawCC-Timestamp': timestamp,
        'X-ClawCC-Nonce': nonce,
        'X-ClawCC-Signature': signature
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let responseBody = '';
      let responseSize = 0;
      res.on('data', c => {
        responseSize += c.length;
        if (responseSize > maxResponseSize) {
          req.destroy();
          reject(new Error('Response too large'));
          return;
        }
        responseBody += c;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { resolve({ success: false, raw: responseBody.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function register() {
  const tailscale = discoverTailscale();
  try {
    const result = await signedRequest('POST', '/api/fleet/register', {
      nodeId: config.nodeId,
      hostname: os.hostname(),
      os: os.platform(),
      tags: config.tags || [],
      tailscaleIp: tailscale ? tailscale.ip : null
    });
    console.log('Registration:', result.success ? 'OK' : 'Failed');
    controlPlaneReachable = !!result.success;
    if (controlPlaneReachable) resetBackoff();
    else increaseBackoff();
  } catch (err) {
    console.error('Registration failed:', err.message);
    controlPlaneReachable = false;
    increaseBackoff();
  }
}

async function heartbeat() {
  // Exponential backoff when control plane is unreachable
  if (backoffMs > 0 && !controlPlaneReachable) {
    return; // Skip this heartbeat, backoff timer handles retry
  }

  const health = collectHealth();
  const sessions = discoverSessions(discoveryPaths);

  try {
    const result = await signedRequest('POST', '/api/fleet/heartbeat', {
      nodeId: config.nodeId,
      health,
      sessions: sessions.slice(0, 100).map(s => ({ id: s.id, project: s.project, lastModified: s.lastModified })),
      timestamp: new Date().toISOString()
    });
    controlPlaneReachable = true;
    resetBackoff();

    // Process commands from control plane
    if (result.commands && Array.isArray(result.commands) && result.commands.length > 0) {
      for (const cmd of result.commands) {
        if (!cmd || !cmd.action) {
          console.warn('Skipping malformed command:', JSON.stringify(cmd));
          continue;
        }
        console.log('Received command:', cmd.action);
        await handleCommand(cmd);
      }
    }
  } catch (err) {
    controlPlaneReachable = false;
    increaseBackoff();
    console.error('Heartbeat failed (backoff:', backoffMs + 'ms):', err.message);
    // Spool health event
    spooler.spool({
      ts: new Date().toISOString(),
      nodeId: config.nodeId,
      sessionId: null,
      type: 'node.heartbeat',
      severity: 'info',
      payload: { health, offline: true }
    });
  }
}

async function handleCommand(cmd) {
  try {
    let allowlists;
    try { allowlists = loadAllowlists(path.resolve(allowlistsDir)); }
    catch { allowlists = { commands: new Map(), paths: new Set() }; }

    const action = { type: 'command', name: cmd.action, args: cmd.args || [] };
    const validation = validateAction(action, allowlists);

    if (!validation.valid) {
      console.error('Command rejected:', validation.errors);
      return;
    }

    const result = await executeAction(action, allowlists);
    console.log('Command result:', result.success ? 'OK' : result.error);
  } catch (err) {
    console.error('Command execution error:', err.message);
  }
}

async function drainSpool() {
  if (!controlPlaneReachable) return;
  const spoolSize = spooler.getSpoolSize();
  if (spoolSize.files === 0) return;

  console.log('Draining spool:', spoolSize.files, 'files,', spoolSize.totalBytes, 'bytes');
  const result = await spooler.drain(controlPlaneUrl, nodeSecret);
  if (result.sent > 0) console.log('Spool drained:', result.sent, 'events sent');
}

// Main loop
async function main() {
  console.log('');
  console.log('ClawCC Node Agent');
  console.log('NodeId:', config.nodeId);
  console.log('Control Plane:', controlPlaneUrl);
  console.log('Tags:', (config.tags || []).join(', ') || 'none');
  console.log('');

  await register();

  // Store interval handles for cleanup on shutdown
  const heartbeatInterval = setInterval(heartbeat, heartbeatIntervalMs);
  const drainInterval = setInterval(drainSpool, 30000);

  // Backoff retry timer for reconnection
  const backoffInterval = setInterval(async () => {
    if (backoffMs > 0 && !controlPlaneReachable) {
      console.log('Retrying control plane connection (backoff:', backoffMs + 'ms)...');
      await heartbeat();
    }
  }, Math.max(heartbeatIntervalMs, 5000));

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nReceived', signal, '- shutting down...');
    clearInterval(heartbeatInterval);
    clearInterval(drainInterval);
    clearInterval(backoffInterval);
    healthCollector.stop();
    // Allow in-flight requests a moment to complete
    setTimeout(() => process.exit(0), 1000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Initial heartbeat
  await heartbeat();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
