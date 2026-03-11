#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const readline = require('node:readline');

// ── Version ──
const VERSION = '0.1.0';

// ── ANSI Colors ──
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

let useColor = true;

function c(color, text) {
  if (!useColor) return text;
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function bold(text) { return c('bold', text); }

// ── Output helpers ──
function out(text) { process.stdout.write(text + '\n'); }
function err(text) { process.stderr.write(c('red', 'Error: ') + text + '\n'); }

// ── Table formatting ──
function formatTable(headers, rows, widths) {
  if (!widths) {
    widths = headers.map((h, i) => {
      let max = h.length;
      for (const row of rows) {
        const val = String(row[i] || '');
        if (val.length > max) max = val.length;
      }
      return Math.min(max + 2, 40);
    });
  }
  const pad = (s, w) => {
    s = String(s || '');
    if (s.length > w - 1) s = s.slice(0, w - 4) + '...';
    return s.padEnd(w);
  };
  const headerLine = headers.map((h, i) => c('bold', pad(h, widths[i]))).join('');
  const separator = widths.map(w => '-'.repeat(w)).join('');
  const lines = [headerLine, separator];
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell, widths[i])).join(''));
  }
  return lines.join('\n');
}

// ── HTTP client ──
function request(method, urlStr, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Stream client (SSE) ──
function streamEvents(urlStr, token, onEvent) {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const opts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' }
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  const req = mod.request(opts, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            onEvent(event);
          } catch {
            onEvent({ raw: line.slice(6) });
          }
        }
      }
    });
    res.on('end', () => out(c('gray', 'Stream ended')));
  });
  req.on('error', (e) => err(`Stream error: ${e.message}`));
  req.end();
  return req;
}

// ── Confirm prompt ──
function confirm(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// ── Parse args ──
function parseArgs(argv) {
  const args = { _: [], options: {} };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--no-color') {
      args.options.noColor = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.options[key] = argv[++i];
      } else {
        args.options[key] = true;
      }
    } else {
      args._push(arg);
    }
    i++;
  }
  return args;
}

// Safer arg parser that doesn't break on _push
function parseArgv(argv) {
  const positional = [];
  const options = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--no-color') {
      options.noColor = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        options[key] = argv[++i];
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { positional, options };
}

// ── Config ──
const CONFIG_DIR = path.join(os.homedir(), '.clawcc');

function loadConfig() {
  const configPath = path.join(CONFIG_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {};
}

// ── Severity coloring ──
function colorSeverity(severity) {
  switch (severity) {
    case 'info': return c('cyan', severity);
    case 'warning': return c('yellow', severity);
    case 'error': return c('red', severity);
    case 'critical': return c('bold', c('red', severity));
    default: return severity;
  }
}

// ── Commands ──

async function cmdInit() {
  out(bold('Initializing ClawCC configuration...'));
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const configPath = path.join(CONFIG_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      host: 'http://localhost:3400',
      format: 'table'
    }, null, 2));
    out(c('green', `  Created ${configPath}`));
  }

  // Generate key pair if not exists
  const keyDir = path.join(CONFIG_DIR, 'keys');
  if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
  const privPath = path.join(keyDir, 'private.pem');
  const pubPath = path.join(keyDir, 'public.pem');
  if (!fs.existsSync(privPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey);
    out(c('green', `  Generated key pair in ${keyDir}`));
  }

  // Copy example configs
  const projectConfig = path.join(__dirname, '..', 'config');
  if (fs.existsSync(projectConfig)) {
    const dest = path.join(CONFIG_DIR, 'examples');
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(projectConfig)) {
      const src = path.join(projectConfig, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(dest, f));
      }
    }
    out(c('green', `  Copied example configs to ${dest}`));
  }

  out(c('green', '\nInitialization complete.'));
}

async function cmdEnroll(host, token, options) {
  const hostname = os.hostname();
  const nodeInfo = {
    hostname,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: Math.round(os.totalmem() / 1024 / 1024),
    nodeVersion: process.version
  };
  out(`Enrolling node ${c('bold', hostname)}...`);
  try {
    const res = await request('POST', `${host}/api/fleet/register`, nodeInfo, token);
    if (res.status === 200 || res.status === 201) {
      out(c('green', `Node enrolled successfully. ID: ${res.data.id || res.data.nodeId || 'assigned'}`));
    } else {
      err(`Enrollment failed: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    err(`Connection failed: ${e.message}`);
  }
}

async function cmdStatus(host, token, format) {
  try {
    const res = await request('GET', `${host}/api/fleet/nodes`, null, token);
    const nodes = Array.isArray(res.data) ? res.data : (res.data.nodes || []);
    if (format === 'json') {
      out(JSON.stringify(res.data, null, 2));
      return;
    }
    const total = nodes.length;
    const online = nodes.filter(n => n.status === 'online').length;
    const offline = total - online;
    out(bold('Fleet Status'));
    out(`  Total nodes:  ${total}`);
    out(`  Online:       ${c('green', String(online))}`);
    out(`  Offline:      ${offline > 0 ? c('red', String(offline)) : '0'}`);
  } catch (e) {
    err(`Failed to get status: ${e.message}`);
  }
}

async function cmdNodes(host, token, format) {
  try {
    const res = await request('GET', `${host}/api/fleet/nodes`, null, token);
    const nodes = Array.isArray(res.data) ? res.data : (res.data.nodes || []);
    if (format === 'json') {
      out(JSON.stringify(nodes, null, 2));
      return;
    }
    if (nodes.length === 0) {
      out('No nodes registered.');
      return;
    }
    const headers = ['ID', 'Hostname', 'Status', 'Platform', 'Last Seen'];
    const rows = nodes.map(n => [
      n.id || n.nodeId || '-',
      n.hostname || '-',
      n.status || 'unknown',
      n.platform || '-',
      n.lastSeen ? new Date(n.lastSeen).toLocaleString() : '-'
    ]);
    out(formatTable(headers, rows));
  } catch (e) {
    err(`Failed to list nodes: ${e.message}`);
  }
}

async function cmdSessions(host, token, format) {
  try {
    const res = await request('GET', `${host}/api/sessions`, null, token);
    const sessions = Array.isArray(res.data) ? res.data : (res.data.sessions || []);
    if (format === 'json') {
      out(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      out('No active sessions.');
      return;
    }
    const headers = ['ID', 'Node', 'User', 'Status', 'Started'];
    const rows = sessions.map(s => [
      s.id || '-',
      s.nodeId || s.node || '-',
      s.user || '-',
      s.status || 'active',
      s.startedAt ? new Date(s.startedAt).toLocaleString() : '-'
    ]);
    out(formatTable(headers, rows));
  } catch (e) {
    err(`Failed to list sessions: ${e.message}`);
  }
}

async function cmdFeed(host, token) {
  out(c('gray', `Connecting to event feed at ${host}...`));
  out(c('gray', 'Press Ctrl+C to stop.\n'));
  streamEvents(`${host}/api/events/stream`, token, (event) => {
    const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const severity = colorSeverity(event.severity || 'info');
    const type = event.type || 'event';
    const node = event.nodeId || '-';
    const msg = event.message || event.raw || JSON.stringify(event);
    out(`${c('gray', ts)} [${severity}] ${c('bold', type)} ${c('gray', 'node=' + node)} ${msg}`);
  });
}

async function cmdPolicyList(host, token, format) {
  try {
    const res = await request('GET', `${host}/api/policies`, null, token);
    const policies = Array.isArray(res.data) ? res.data : (res.data.policies || []);
    if (format === 'json') {
      out(JSON.stringify(policies, null, 2));
      return;
    }
    if (policies.length === 0) {
      out('No policies configured.');
      return;
    }
    const headers = ['ID', 'Name', 'Enabled', 'Priority', 'Rules'];
    const rows = policies.map(p => [
      p.id || '-',
      p.name || '-',
      p.enabled !== false ? 'yes' : 'no',
      String(p.priority || 0),
      String((p.rules || []).length)
    ]);
    out(formatTable(headers, rows));
  } catch (e) {
    err(`Failed to list policies: ${e.message}`);
  }
}

async function cmdPolicyApply(host, token, filePath) {
  if (!filePath) { err('Usage: clawcc policy apply <file>'); process.exit(1); }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const res = await request('POST', `${host}/api/policies`, data, token);
    if (res.status === 200 || res.status === 201) {
      out(c('green', `Policy applied: ${data.name || data.id}`));
    } else {
      err(`Failed to apply policy: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    err(`Failed: ${e.message}`);
  }
}

async function cmdPolicySimulate(host, token, sessionId) {
  if (!sessionId) { err('Usage: clawcc policy simulate <session-id>'); process.exit(1); }
  try {
    const res = await request('POST', `${host}/api/policies/simulate`, { sessionId }, token);
    out(JSON.stringify(res.data, null, 2));
  } catch (e) {
    err(`Failed: ${e.message}`);
  }
}

async function cmdKillSession(host, token, id) {
  if (!id) { err('Usage: clawcc kill session <id>'); process.exit(1); }
  const ok = await confirm(`Kill session ${id}?`);
  if (!ok) { out('Aborted.'); return; }
  try {
    const res = await request('POST', `${host}/api/sessions/${id}/kill`, {}, token);
    out(res.status < 300 ? c('green', 'Session killed.') : c('red', `Failed: ${JSON.stringify(res.data)}`));
  } catch (e) { err(e.message); }
}

async function cmdKillNode(host, token, id) {
  if (!id) { err('Usage: clawcc kill node <id>'); process.exit(1); }
  const ok = await confirm(`Kill all sessions on node ${id}?`);
  if (!ok) { out('Aborted.'); return; }
  try {
    const res = await request('POST', `${host}/api/fleet/nodes/${id}/kill`, {}, token);
    out(res.status < 300 ? c('green', 'All sessions on node killed.') : c('red', `Failed: ${JSON.stringify(res.data)}`));
  } catch (e) { err(e.message); }
}

async function cmdKillGlobal(host, token) {
  const ok = await confirm(c('red', 'GLOBAL KILL SWITCH - terminate ALL sessions?'));
  if (!ok) { out('Aborted.'); return; }
  try {
    const res = await request('POST', `${host}/api/kill/global`, {}, token);
    out(res.status < 300 ? c('green', 'Global kill executed.') : c('red', `Failed: ${JSON.stringify(res.data)}`));
  } catch (e) { err(e.message); }
}

async function cmdVerify(filePath) {
  if (!filePath) { err('Usage: clawcc verify <path>'); process.exit(1); }
  try {
    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { hashData } = require('../control-plane/lib/crypto');
    // Verify hash chain
    let valid = true;
    for (let i = 0; i < bundle.receipts.length; i++) {
      const r = bundle.receipts[i];
      const expectedHash = hashData(r.prevHash + hashData(r.data));
      if (r.hash !== expectedHash) {
        out(c('red', `Chain broken at index ${i}`));
        valid = false;
        break;
      }
      if (i > 0 && r.prevHash !== bundle.receipts[i - 1].hash) {
        out(c('red', `Previous hash mismatch at index ${i}`));
        valid = false;
        break;
      }
    }
    if (bundle.signature && bundle.hash) {
      const bundleHash = hashData(JSON.stringify(bundle.receipts));
      if (bundleHash !== bundle.hash) {
        out(c('red', 'Bundle hash mismatch'));
        valid = false;
      }
    }
    if (valid) {
      out(c('green', `Bundle verified: ${bundle.receipts.length} receipts, chain intact.`));
    } else {
      out(c('red', 'Verification FAILED'));
      process.exit(1);
    }
  } catch (e) {
    err(`Verification failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdExport(host, token, sessionId) {
  if (!sessionId) { err('Usage: clawcc export <session-id>'); process.exit(1); }
  try {
    const res = await request('POST', `${host}/api/governance/evidence/export`, { sessionId }, token);
    const outPath = `evidence-${sessionId}.json`;
    fs.writeFileSync(outPath, JSON.stringify(res.data, null, 2));
    out(c('green', `Evidence bundle saved to ${outPath}`));
  } catch (e) { err(e.message); }
}

async function cmdUsersList(host, token, format) {
  try {
    const res = await request('GET', `${host}/api/users`, null, token);
    const users = Array.isArray(res.data) ? res.data : (res.data.users || []);
    if (format === 'json') {
      out(JSON.stringify(users, null, 2));
      return;
    }
    const headers = ['Username', 'Role', 'MFA'];
    const rows = users.map(u => [u.username, u.role, u.mfaEnabled ? 'yes' : 'no']);
    out(formatTable(headers, rows));
  } catch (e) { err(e.message); }
}

async function cmdUsersCreate(host, token) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  try {
    const username = await ask('Username: ');
    const password = await ask('Password: ');
    const role = await ask('Role (viewer/operator/admin): ') || 'viewer';
    rl.close();
    const res = await request('POST', `${host}/api/users`, { username, password, role }, token);
    if (res.status < 300) {
      out(c('green', `User ${username} created with role ${role}`));
    } else {
      err(JSON.stringify(res.data));
    }
  } catch (e) { rl.close(); err(e.message); }
}

async function cmdReceiptsVerify(host, token, options) {
  const date = options.date || new Date().toISOString().split('T')[0];
  try {
    const res = await request('GET', `${host}/api/governance/receipts/verify?date=${date}`, null, token);
    if (res.data.valid) {
      out(c('green', `Receipt chain for ${date} is valid (${res.data.count || '?'} receipts)`));
    } else {
      out(c('red', `Receipt chain for ${date} is INVALID: ${res.data.reason || 'unknown'}`));
    }
  } catch (e) { err(e.message); }
}

async function cmdKeygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const privFile = 'clawcc-private.pem';
  const pubFile = 'clawcc-public.pem';
  fs.writeFileSync(privFile, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubFile, publicKey);
  out(c('green', `Key pair generated:`));
  out(`  Private key: ${privFile}`);
  out(`  Public key:  ${pubFile}`);
}

function showHelp() {
  out(`
${bold('ClawCC')} - AI Agent Fleet Control Center CLI v${VERSION}

${bold('Usage:')} clawcc <command> [options]

${bold('Commands:')}
  init              Initialize ClawCC configuration
  enroll            Enroll a node into the fleet
  status            Show fleet status
  nodes             List fleet nodes
  sessions          List active sessions
  feed              Tail live event feed (SSE)
  policy list       List policies
  policy apply      Apply a policy file
  policy simulate   Simulate policy on a session
  kill session <id> Kill a session
  kill node <id>    Kill all sessions on a node
  kill global       Global kill switch
  verify <path>     Verify an evidence bundle
  export <session>  Export evidence bundle for session
  users list        List users
  users create      Create a user
  receipts verify   Verify receipt chain for a date
  keygen            Generate Ed25519 key pair
  version           Show version

${bold('Options:')}
  --host <url>      Control plane URL (default: http://localhost:3400)
  --token <token>   Auth token
  --format <fmt>    Output format: table (default), json
  --no-color        Disable colors
`);
}

// ── Main ──
async function main() {
  const { positional, options } = parseArgv(process.argv.slice(2));

  if (options.noColor) useColor = false;

  const config = loadConfig();
  const host = options.host || config.host || 'http://localhost:3400';
  const token = options.token || config.token || process.env.CLAWCC_TOKEN || null;
  const format = options.format || config.format || 'table';

  const cmd = positional[0];
  const sub = positional[1];
  const arg = positional[2];

  switch (cmd) {
    case 'init': return cmdInit();
    case 'enroll': return cmdEnroll(host, token, options);
    case 'status': return cmdStatus(host, token, format);
    case 'nodes': return cmdNodes(host, token, format);
    case 'sessions': return cmdSessions(host, token, format);
    case 'feed': return cmdFeed(host, token);
    case 'policy':
      switch (sub) {
        case 'list': return cmdPolicyList(host, token, format);
        case 'apply': return cmdPolicyApply(host, token, arg);
        case 'simulate': return cmdPolicySimulate(host, token, arg);
        default: err(`Unknown policy subcommand: ${sub}`); showHelp(); process.exit(1);
      }
      break;
    case 'kill':
      switch (sub) {
        case 'session': return cmdKillSession(host, token, arg);
        case 'node': return cmdKillNode(host, token, arg);
        case 'global': return cmdKillGlobal(host, token);
        default: err(`Unknown kill subcommand: ${sub}`); showHelp(); process.exit(1);
      }
      break;
    case 'verify': return cmdVerify(sub);
    case 'export': return cmdExport(host, token, sub);
    case 'users':
      switch (sub) {
        case 'list': return cmdUsersList(host, token, format);
        case 'create': return cmdUsersCreate(host, token);
        default: err(`Unknown users subcommand: ${sub}`); showHelp(); process.exit(1);
      }
      break;
    case 'receipts':
      switch (sub) {
        case 'verify': return cmdReceiptsVerify(host, token, options);
        default: err(`Unknown receipts subcommand: ${sub}`); showHelp(); process.exit(1);
      }
      break;
    case 'keygen': return cmdKeygen();
    case 'version': out(`ClawCC v${VERSION}`); break;
    case 'help': case '--help': case '-h': case undefined: showHelp(); break;
    default: err(`Unknown command: ${cmd}`); showHelp(); process.exit(1);
  }
}

main().catch(e => { err(e.message); process.exit(1); });

module.exports = { formatTable, parseArgv, VERSION };
