#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load config
const configPaths = [
  process.env.CLAWCC_CONFIG,
  path.join(process.cwd(), 'clawcc.config.json'),
  path.join(__dirname, '..', 'config', 'clawcc.config.json'),
  path.join(__dirname, '..', 'config', 'clawcc.config.example.json')
].filter(Boolean);

let config = {};
for (const cp of configPaths) {
  try {
    config = JSON.parse(fs.readFileSync(cp, 'utf8'));
    console.log('Config loaded from:', cp);
    break;
  } catch { /* try next */ }
}

config.host = config.host || '0.0.0.0';
config.port = config.port || 3400;
config.dataDir = path.resolve(config.dataDir || './data');
config.httpsEnabled = config.httpsEnabled || false;

// Validate critical config
if (config.port && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
  console.error('FATAL: Invalid port:', config.port);
  process.exit(1);
}
if (config.httpsEnabled) {
  if (!config.httpsKeyPath || !config.httpsCertPath) {
    console.error('FATAL: httpsEnabled=true but httpsKeyPath or httpsCertPath not set');
    process.exit(1);
  }
  try {
    fs.accessSync(config.httpsKeyPath, fs.constants.R_OK);
    fs.accessSync(config.httpsCertPath, fs.constants.R_OK);
  } catch (err) {
    console.error('FATAL: Cannot read TLS cert/key:', err.message);
    process.exit(1);
  }
}

// Create data directories
const dataDirs = ['events', 'snapshots', 'audit', 'receipts', 'receipts/roots', 'fleet', 'intents', 'users'];
for (const d of dataDirs) {
  fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
}

// Load modules
const cryptoMod = require('./lib/crypto');
const { createAuthManager } = require('./lib/auth');
const auditMod = require('./lib/audit');
const { createEventStore } = require('./lib/events');
const snapshotsMod = require('./lib/snapshots');
const { createReceiptStore } = require('./lib/receipts');
const { createPolicyEngine } = require('./lib/policy');
const intentMod = require('./lib/intent');
const { createRouter } = require('./lib/router');
const { createIndex } = require('./lib/index');
const { createSqliteStore } = require('./lib/sqlite-store');
const { securityHeaders, rateLimiter } = require('./middleware/security');

// Initialize modules
auditMod.init(config.dataDir);

// Auth manager - wraps factory to match route expectations
const authManager = createAuthManager({
  maxFailures: config.auth ? config.auth.lockoutAttempts || 5 : 5,
  lockoutMs: config.auth ? config.auth.lockoutDurationMs || 900000 : 900000,
  sessionTTL: config.auth ? config.auth.sessionTtlMs || 86400000 : 86400000,
  stepUpWindow: config.auth ? config.auth.stepUpWindowMs || 300000 : 300000,
  dataDir: config.dataDir
});
const defaultAdminPw = config.auth && config.auth.defaultAdminPassword ? config.auth.defaultAdminPassword : 'changeme';
authManager.createDefaultAdmin(defaultAdminPw);
if (defaultAdminPw === 'changeme') {
  if (config.mode === 'production') {
    console.error('FATAL: Default admin password is "changeme" — set config.auth.defaultAdminPassword before running in production');
    process.exit(1);
  }
  console.warn('[SECURITY] Default admin password is "changeme" — change it immediately via /api/auth/change-password or config.auth.defaultAdminPassword');
}

// Auth adapter: route handlers call auth.authenticateUser(dataDir, user, pass) etc
const auth = {
  authenticateUser(dataDir, username, password) {
    try {
      const user = authManager.authenticate(username, password);
      return { success: true, user, requiresMfa: user.mfaEnabled, requiresPasswordChange: false };
    } catch {
      return { success: false };
    }
  },
  createSession(user, opts = {}) {
    const username = user.username || user.user?.username || 'admin';
    const token = authManager.createSession(username, { mfaPending: !!opts.mfaPending });
    return { token, expiresAt: Date.now() + (opts.mfaPending ? 300000 : 86400000) };
  },
  upgradeSession(token) {
    return authManager.upgradeSession(token);
  },
  validateSession(token) {
    return authManager.validateSession(token);
  },
  destroySession(token) {
    return authManager.destroySession(token);
  },
  getSession(token) {
    const user = authManager.validateSession(token);
    if (!user) return null;
    const stepUpAt = authManager.getStepUpAt ? authManager.getStepUpAt(token) : 0;
    return { ...user, lastStepUp: stepUpAt };
  },
  checkPermission(user, action) {
    if (!user) return false;
    const role = (user.role || '').toLowerCase();
    if (role === 'admin') return true;
    if (action.startsWith('read:') || action.startsWith('stream:')) return true;
    if (action === 'audit:read' || action === 'export:evidence') return role === 'auditor' || role === 'admin';
    if (action === 'action:safe' || action === 'action:cron') return role === 'operator' || role === 'admin';
    return false;
  },
  enableMfa(dataDir, username) {
    const result = authManager.setupMFA(username);
    return { secret: result.secret, qrUri: 'otpauth://totp/ClawCC:' + username + '?secret=' + result.secret + '&issuer=ClawCC', recoveryCodes: result.recoveryCodes };
  },
  verifyMfaLogin(dataDir, username, code) {
    try {
      const result = authManager.verifyMFA(username, code);
      if (result) {
        const user = authManager.getUser(username);
        return { success: true, user };
      }
      return { success: false };
    } catch { return { success: false }; }
  },
  recordStepUp(token) {
    return authManager.stepUpAuth(token);
  },
  changePassword(username, oldPassword, newPassword) {
    return authManager.changePassword(username, oldPassword, newPassword);
  },
  updatePassword(username, newPassword) {
    return authManager.updatePassword(username, newPassword);
  },
  loadUsers(dataDir) {
    return authManager.listUsers();
  },
  init() { /* already initialized */ }
};

// Event store
const eventStoreInstance = createEventStore({ dataDir: path.join(config.dataDir, 'events') });

// SQLite acceleration layer (optional — graceful fallback if unavailable)
const sqliteConfig = config.sqlite || {};
const sqliteEnabled = sqliteConfig.enabled !== false;
let sqliteStore = null;
if (sqliteEnabled) {
  const sqlitePath = sqliteConfig.path
    ? path.resolve(sqliteConfig.path)
    : path.join(config.dataDir, 'index.sqlite');
  sqliteStore = createSqliteStore({
    path: sqlitePath,
    walMode: sqliteConfig.walMode !== false
  });
  if (sqliteStore) {
    console.log('SQLite acceleration: enabled (' + sqlitePath + ')');
    auditMod.setSqliteStore(sqliteStore);
  } else {
    console.log('SQLite acceleration: unavailable (node:sqlite not found, using in-memory only)');
  }
}

// Hybrid Index Layer: in-memory indexes over JSONL, rebuilt on boot
// When SQLite is available, queries are delegated there for faster compound filtering
const index = createIndex({ sqliteStore });

// Events adapter: routes call events.ingest(event), events.subscribe(filter, cb), events.query(dataDir, filters)
const events = {
  ingest(event) {
    // Adapt field names: routes use 'ts' but store expects 'timestamp'
    const adapted = { ...event };
    if (adapted.ts && !adapted.timestamp) adapted.timestamp = adapted.ts;
    if (!adapted.timestamp) adapted.timestamp = new Date().toISOString();
    if (!adapted.nodeId) adapted.nodeId = 'local';
    try {
      const stored = eventStoreInstance.ingest(adapted);
      // Update in-memory index with redacted event (not the raw adapted one)
      index.indexEvent(stored);
      return stored;
    }
    catch (err) {
      // Log validation errors instead of silently swallowing
      if (err.message) console.warn('Event ingest error:', err.message);
    }
  },
  subscribe(filter, callback) {
    // The factory subscribe doesn't support filters - we filter in the wrapper
    return eventStoreInstance.subscribe((event) => {
      if (filter && filter.nodeId && event.nodeId !== filter.nodeId) return;
      if (filter && filter.sessionId && event.sessionId !== filter.sessionId) return;
      if (filter && filter.type && event.type !== filter.type) return;
      if (filter && filter.severity && event.severity !== filter.severity) return;
      callback(event);
    });
  },
  query(dataDir, filters) {
    // Delegate to in-memory index instead of full JSONL file scan
    return index.query(filters);
  }
};

// Receipt store
const receiptStore = createReceiptStore({ dataDir: config.dataDir });
const receipts = {
  createReceipt: receiptStore.createReceipt,
  verify(dataDir, date, publicKey) { return receiptStore.verifyChain(); },
  exportBundle(dataDir, sessionId, opts) {
    return receiptStore.exportBundle();
  },
  verifyBundle(bundle) { return receiptStore.verifyBundle(bundle); },
  getSessionReceipt(sessionId) { return null; },
  signDailyRoot: receiptStore.signDailyRoot
};

// Policy engine
const policyEngine = createPolicyEngine();
// Load policies from disk
try {
  const policiesDir = path.resolve(__dirname, '..', 'policies');
  const policyFiles = fs.readdirSync(policiesDir).filter(f => f.endsWith('.json'));
  for (const pf of policyFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(policiesDir, pf), 'utf8'));
      policyEngine.loadPolicy(data);
    } catch { /* skip bad policy files */ }
  }
} catch { /* no policies dir */ }

const policy = {
  loadPolicies(dir) {
    const policies = [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try { policies.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
      }
    } catch {}
    return policies;
  },
  evaluateEvent: (policies, event) => ({ violations: [] }),
  evaluateSession: (policies, events) => ({ driftScore: 0, violations: [], reasons: [] }),
  simulatePolicy(targetPolicy, sessionEvents) {
    const timeline = sessionEvents.map((event, i) => {
      const matched = [];
      for (const rule of (targetPolicy.rules || [])) {
        // Unwrap condition if present (policy JSON uses condition.field, engine expects rule.field)
        const evalRule = rule.condition ? { ...rule.condition } : rule;
        const ctx = { ...event, ...(event.payload || {}) };
        if (policyEngine.evaluateRule(evalRule, ctx)) {
          matched.push({ ruleId: rule.id || evalRule.field, enforcement: rule.enforcement || rule.action, message: rule.message || '' });
        }
      }
      return { step: i + 1, ts: event.ts || event.timestamp, type: event.type, wouldBlock: matched.length > 0, violations: matched };
    });
    return { timeline, blockedSteps: timeline.filter(t => t.wouldBlock).length, totalSteps: timeline.length };
  }
};

// Tripwire auto-quarantine: subscribe to events and quarantine on tripwire triggers
events.subscribe({ type: 'tripwire.triggered' }, (event) => {
  const nodeId = event.nodeId || null;
  const sessionId = event.sessionId || null;
  const ts = new Date().toISOString();

  // Quarantine the session
  if (sessionId) {
    events.ingest({ ts, nodeId, sessionId, type: 'session.ended', severity: 'critical',
      payload: { reason: 'tripwire-auto-quarantine', tripwireId: event.payload?.tripwireId, source: 'auto' } });
  }
  // Quarantine the node
  if (nodeId) {
    events.ingest({ ts, nodeId, sessionId: null, type: 'node.quarantined', severity: 'critical',
      payload: { reason: 'tripwire-auto-quarantine', tripwireId: event.payload?.tripwireId, source: 'auto' } });
  }
  // Auto-export evidence bundle
  try { receiptStore.createReceipt(JSON.stringify({ type: 'tripwire-quarantine', nodeId, sessionId, ts, tripwireId: event.payload?.tripwireId })); } catch { /* ignore */ }
  // Audit log
  auditMod.log({ actor: 'system', action: 'tripwire.auto-quarantine', target: sessionId || nodeId || 'unknown',
    detail: JSON.stringify({ tripwireId: event.payload?.tripwireId, nodeId, sessionId }) });
});

// Auto-rollback: track canary deployments and error rates (capped at 100 entries)
const CANARY_MAX = 100;
const canaryDeployments = new Map(); // skillId -> { deployedAt, nodeIds, errorCount }
events.subscribe({ type: 'skill.deployed' }, (event) => {
  if (event.payload?.canary) {
    // Evict expired entries before adding
    if (canaryDeployments.size >= CANARY_MAX) {
      const now = Date.now();
      for (const [sid, info] of canaryDeployments) {
        if (now - info.deployedAt > 600000) canaryDeployments.delete(sid);
      }
    }
    if (canaryDeployments.size < CANARY_MAX) {
      canaryDeployments.set(event.payload.skillId, { deployedAt: Date.now(), errorCount: 0 });
    }
  }
});
events.subscribe({}, (event) => {
  if (event.type === 'session.error' || event.type === 'tool.error') {
    for (const [skillId, info] of canaryDeployments) {
      if (Date.now() - info.deployedAt < 600000) { // 10 min window
        info.errorCount++;
        if (info.errorCount >= 5) {
          events.ingest({ ts: new Date().toISOString(), nodeId: null, sessionId: null, type: 'skill.rolledback', severity: 'warning', payload: { skillId, reason: 'auto-rollback', errorCount: info.errorCount } });
          auditMod.log({ actor: 'system', action: 'skill.auto-rollback', target: skillId, detail: 'Error threshold exceeded: ' + info.errorCount + ' errors in canary window' });
          canaryDeployments.delete(skillId);
        }
      } else {
        canaryDeployments.delete(skillId);
      }
    }
  }
});

// Module bag for routes
const modules = {
  crypto: cryptoMod,
  auth,
  audit: auditMod,
  events,
  index,
  snapshots: snapshotsMod,
  receipts,
  policy,
  intent: intentMod
};

// Create router and register routes
const router = createRouter();

const { registerAuthRoutes } = require('./routes/auth-routes');
const { registerFleetRoutes } = require('./routes/fleet-routes');
const { registerEventRoutes } = require('./routes/event-routes');
const { registerOpsRoutes } = require('./routes/ops-routes');
const { registerGovernanceRoutes } = require('./routes/governance-routes');
const { registerKillSwitchRoutes } = require('./routes/kill-switch');

registerAuthRoutes(router, config, modules);
registerFleetRoutes(router, config, modules);
registerEventRoutes(router, config, modules);
registerOpsRoutes(router, config, modules);
registerGovernanceRoutes(router, config, modules);
registerKillSwitchRoutes(router, config, modules);

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  let filePath;

  // Pocket PWA
  if (parsed.pathname.startsWith('/pocket')) {
    const pocketPath = parsed.pathname === '/pocket' || parsed.pathname === '/pocket/'
      ? 'index.html'
      : parsed.pathname.replace('/pocket/', '');
    filePath = path.join(__dirname, '..', 'pocket', pocketPath);
  } else {
    const urlPath = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
    filePath = path.join(__dirname, '..', 'ui', urlPath);
  }

  // Prevent path traversal (resolve symlinks to prevent bypass via /tmp -> /private/tmp etc)
  const uiDir = fs.realpathSync(path.resolve(__dirname, '..', 'ui'));
  const pocketDir = fs.realpathSync(path.resolve(__dirname, '..', 'pocket'));
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(filePath)); } catch { resolved = path.resolve(filePath); }
  if (!resolved.startsWith(uiDir) && !resolved.startsWith(pocketDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      // SPA fallback
      filePath = path.join(__dirname, '..', 'ui', 'index.html');
    }

    let content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';

    // Inject CSP nonce into HTML inline scripts and styles
    if (ext === '.html' && res.cspNonce) {
      let html = content.toString('utf8');
      html = html.replace(/<script>/g, '<script nonce="' + res.cspNonce + '">');
      html = html.replace(/<style>/g, '<style nonce="' + res.cspNonce + '">');
      content = Buffer.from(html);
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': cacheControl
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// Rate limiter
const globalRateLimit = rateLimiter(
  (config.security && config.security.rateLimitWindowMs) || 60000,
  (config.security && config.security.rateLimitMaxRequests) || 100
);

// Request timeout (30s default, configurable)
const REQUEST_TIMEOUT_MS = (config.security && config.security.requestTimeoutMs) || 30000;

// Request handler
async function handleRequest(req, res) {
  // Request timeout - prevents hanging connections
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Request timeout' }));
    }
  }, REQUEST_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));

  // Security headers
  securityHeaders(req, res, config.httpsEnabled);

  // CORS handling
  const allowedOrigins = config.cors && config.cors.origins
    ? config.cors.origins
    : ['http://localhost:' + config.port];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ClawCC-NodeId,X-ClawCC-Timestamp,X-ClawCC-Nonce,X-ClawCC-Signature');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Unauthenticated health check for load balancers / k8s probes
  if (req.url === '/healthz' || req.url === '/api/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Rate limiting
  const rateResult = globalRateLimit(req);
  if (!rateResult.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
    return;
  }

  // API routes
  if (req.url.startsWith('/api/')) {
    const handled = await router.handle(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
    }
    return;
  }

  // Static files
  serveStatic(req, res);
}

// Build indexes and snapshots on startup
console.log('Rebuilding index...');
try {
  index.rebuild(config.dataDir);
  console.log('Index rebuilt.');
} catch (err) {
  console.log('Index rebuild skipped:', err.message);
}

// Catch up audit logs into SQLite
if (sqliteStore) {
  try {
    const auditCount = sqliteStore.catchUpAuditFromJSONL(config.dataDir);
    if (auditCount > 0) console.log('SQLite: caught up ' + auditCount + ' audit entries');
  } catch (err) {
    console.log('SQLite audit catch-up skipped:', err.message);
  }
}

console.log('Rebuilding snapshots...');
try {
  snapshotsMod.rebuild(config.dataDir);
  console.log('Snapshots rebuilt.');
} catch (err) {
  console.log('Snapshot rebuild skipped:', err.message);
}

// Track open connections for graceful shutdown
const openConnections = new Set();

// Start server
const server = config.httpsEnabled
  ? https.createServer({
      key: fs.readFileSync(config.httpsKeyPath),
      cert: fs.readFileSync(config.httpsCertPath)
    }, handleRequest)
  : http.createServer(handleRequest);

server.on('connection', (conn) => {
  openConnections.add(conn);
  conn.on('close', () => openConnections.delete(conn));
});

// Set server-level keep-alive timeout
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(config.port, config.host, () => {
  const proto = config.httpsEnabled ? 'https' : 'http';
  console.log('');
  console.log('  ClawCC Fleet Control Center');
  console.log('  Mode: ' + (config.mode || 'local'));
  console.log('  Listening: ' + config.host + ':' + config.port);
  console.log('  UI: ' + proto + '://localhost:' + config.port);
  console.log('  Pocket: ' + proto + '://localhost:' + config.port + '/pocket/');
  console.log('  Data: ' + config.dataDir);
  console.log('');
});

// Periodic snapshot rebuild
const snapshotIntervalMs = (config.events && config.events.snapshotIntervalMs) || 60000;
const snapshotRebuildInterval = setInterval(() => {
  try { snapshotsMod.rebuild(config.dataDir); } catch { /* ignore */ }
}, snapshotIntervalMs);

// Graceful shutdown
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nReceived ' + signal + ' - shutting down...');
  // Flush any pending snapshot writes
  try { index.flushSnapshots(); } catch { /* ignore */ }
  // Log write queue status
  try {
    const stats = eventStoreInstance.getWriteQueueStats();
    if (stats.queued > 0) console.log('Flushing ' + stats.queued + ' pending event writes...');
    if (stats.dropped > 0) console.warn('Warning: ' + stats.dropped + ' writes were dropped due to backpressure during this session');
  } catch { /* ignore */ }
  // Close SQLite
  if (sqliteStore) {
    try { sqliteStore.close(); console.log('SQLite closed.'); } catch { /* ignore */ }
  }
  // Clear snapshot rebuild interval
  clearInterval(snapshotRebuildInterval);
  // Stop accepting new connections
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Destroy lingering connections after grace period
  setTimeout(() => {
    for (const conn of openConnections) {
      try { conn.destroy(); } catch {}
    }
  }, 3000);
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Uncaught exception / rejection handlers - log and keep running for non-fatal errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  auditMod.log({ actor: 'system', action: 'process.uncaughtException', target: 'control-plane', detail: String(err.message || err) });
  // Fatal errors: exit after flushing
  if (err.code === 'ERR_OUT_OF_RANGE' || err.code === 'ERR_BUFFER_OUT_OF_BOUNDS') {
    shutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  auditMod.log({ actor: 'system', action: 'process.unhandledRejection', target: 'control-plane', detail: String(reason) });
});
