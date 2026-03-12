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
const dataDirs = ['events', 'snapshots', 'audit', 'receipts', 'receipts/roots', 'fleet', 'intents', 'users', 'agents', 'agents/souls', 'channels', 'onboarding', 'knowledge', 'tenants', 'tasks', 'webhooks', 'skills-hub', 'evaluations', 'scheduler', 'projects', 'security'];
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
const { createDoctor } = require('./lib/doctor');
const { createBackupManager } = require('./lib/backup');
const { createGateway } = require('./lib/gateway');
const { createAgentTracker } = require('./lib/agents');
const { createChannelManager } = require('./lib/channels');
const { createOnboarding } = require('./lib/onboarding');
const { createKnowledgeGraph } = require('./lib/knowledge-graph');
const { createTenantManager } = require('./lib/tenants');
const { createTaskManager } = require('./lib/tasks');
const { createWebhookManager } = require('./lib/webhooks');
const { createClaudeIntegration } = require('./lib/claude-integration');
const { createSkillsHub } = require('./lib/skills-hub');
const { createEvaluationEngine } = require('./lib/evaluations');
const { createUpdater } = require('./lib/updater');
const { createScheduler } = require('./lib/scheduler');
const { createProjectManager } = require('./lib/projects');
const { createConfigManager } = require('./lib/config-manager');
const { createSecurityProfileManager } = require('./lib/security-profiles');
const { createSecretScanner } = require('./lib/secret-scanner');
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
    return { secret: result.secret, qrUri: 'otpauth://totp/FCC:' + username + '?secret=' + result.secret + '&issuer=FCC', recoveryCodes: result.recoveryCodes };
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
  deleteUser(username) {
    return authManager.deleteUser(username);
  },
  createApiKey(username) {
    return authManager.createApiKey(username);
  },
  revokeApiKey(username, keyPrefix) {
    return authManager.revokeApiKey(username, keyPrefix);
  },
  listApiKeys(username) {
    return authManager.listApiKeys(username);
  },
  authenticateByApiKey(key) {
    return authManager.authenticateByApiKey(key);
  },
  listAllUsers() {
    return authManager.listAllUsers();
  },
  setUserRole(username, role) {
    return authManager.setUserRole(username, role);
  },
  disableUser(username) {
    return authManager.disableUser(username);
  },
  enableUser(username) {
    return authManager.enableUser(username);
  },
  getUserActivity(username) {
    return authManager.getUserActivity(username);
  },
  createUser(username, password, role) {
    return authManager.createUser(username, password, role);
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

// Doctor (diagnostic/health-check system)
const doctor = createDoctor({
  config,
  dataDir: config.dataDir,
  authManager,
  receiptStore,
  eventStore: eventStoreInstance,
  snapshots: snapshotsMod
});

// Backup manager
const backupManager = createBackupManager({ dataDir: config.dataDir });

// Gateway (multi-fleet federation) — opt-in via config.gateway.enabled
let gatewayInstance = null;
if (config.gateway && config.gateway.enabled) {
  gatewayInstance = createGateway({
    dataDir: config.dataDir,
    upstreams: config.gateway.upstreams || [],
    timeoutMs: config.gateway.timeoutMs || 10000
  });
  console.log('Gateway mode: enabled');
}

// Agent tracker
const agentTracker = createAgentTracker({ dataDir: config.dataDir });

// Channel manager (agent communications)
const channelManager = createChannelManager({ dataDir: config.dataDir });

// Onboarding wizard
const onboarding = createOnboarding({ dataDir: config.dataDir });

// Knowledge Graph (enabled by default, opt-out via config.knowledgeGraph.enabled = false)
let knowledgeGraph = null;
if (config.knowledgeGraph?.enabled !== false) {
  knowledgeGraph = createKnowledgeGraph({ dataDir: config.dataDir });
  console.log('Knowledge Graph: enabled');
}

// Multi-Tenant (disabled by default, opt-in via config.multiTenant.enabled = true)
let tenantManager = null;
if (config.multiTenant && config.multiTenant.enabled) {
  tenantManager = createTenantManager({ dataDir: config.dataDir });
  console.log('Multi-Tenant: enabled');
}

// Task manager
const taskManager = createTaskManager({ dataDir: config.dataDir });

// Webhook manager (outbound webhook delivery system)
const webhookManager = createWebhookManager({ dataDir: config.dataDir });

// Claude Code local integration (read-only discovery of ~/.claude data)
const os = require('os');
const claudeIntegration = createClaudeIntegration({ claudeDir: config.claudeDir || path.join(os.homedir(), '.claude') });

// Skills Hub (browse, install, manage agent skills with security scanning)
const skillsHub = createSkillsHub({ dataDir: config.dataDir });

// Evaluation engine (agent quality assessment and quality gates)
const evaluationEngine = createEvaluationEngine({ dataDir: config.dataDir });

// Updater (version check + self-update)
const updater = createUpdater({ projectRoot: path.resolve(__dirname, '..'), apiUrl: config.updater && config.updater.apiUrl });

// Natural Language Scheduler (recurring jobs with NL expressions)
const scheduler = createScheduler({ dataDir: config.dataDir, taskManager, webhookManager });

// Project manager
const projectManager = createProjectManager({ dataDir: config.dataDir });

// Config manager (wraps running config for export/import/validation)
const configManager = createConfigManager({ config });

// Security profile manager (tunable strictness levels for security responses)
const securityProfiles = createSecurityProfileManager({ dataDir: config.dataDir });

// Secret scanner (pattern-based secret detection in text content)
const secretScanner = createSecretScanner();

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
  intent: intentMod,
  doctor,
  backupManager,
  gateway: gatewayInstance,
  agentTracker,
  channelManager,
  onboarding,
  knowledgeGraph,
  tenantManager,
  taskManager,
  webhookManager,
  claudeIntegration,
  skillsHub,
  evaluationEngine,
  updater,
  scheduler,
  projectManager,
  configManager,
  securityProfiles,
  secretScanner
};

// Create router and register routes
const router = createRouter();

const { registerAuthRoutes } = require('./routes/auth-routes');
const { registerFleetRoutes } = require('./routes/fleet-routes');
const { registerEventRoutes } = require('./routes/event-routes');
const { registerOpsRoutes } = require('./routes/ops-routes');
const { registerGovernanceRoutes } = require('./routes/governance-routes');
const { registerKillSwitchRoutes } = require('./routes/kill-switch');
const { registerDoctorRoutes } = require('./routes/doctor-routes');
const { registerGatewayRoutes } = require('./routes/gateway-routes');
const { registerAgentRoutes } = require('./routes/agent-routes');
const { registerChannelRoutes } = require('./routes/channel-routes');
const { registerOnboardingRoutes } = require('./routes/onboarding-routes');
const { registerKnowledgeRoutes } = require('./routes/knowledge-routes');
const { registerTenantRoutes } = require('./routes/tenant-routes');
const { registerTaskRoutes } = require('./routes/task-routes');
const { registerWebhookRoutes } = require('./routes/webhook-routes');
const { registerClaudeRoutes } = require('./routes/claude-routes');
const { registerSkillsHubRoutes } = require('./routes/skills-hub-routes');
const { registerEvaluationRoutes } = require('./routes/evaluation-routes');
const { registerUpdaterRoutes } = require('./routes/updater-routes');
const { registerSchedulerRoutes } = require('./routes/scheduler-routes');
const { registerUserRoutes } = require('./routes/user-routes');
const { registerProjectRoutes } = require('./routes/project-routes');
const { registerConfigRoutes } = require('./routes/config-routes');
const { registerSecurityRoutes } = require('./routes/security-routes');

registerAuthRoutes(router, config, modules);
registerFleetRoutes(router, config, modules);
registerEventRoutes(router, config, modules);
registerOpsRoutes(router, config, modules);
registerGovernanceRoutes(router, config, modules);
registerKillSwitchRoutes(router, config, modules);
registerDoctorRoutes(router, config, modules);
registerAgentRoutes(router, config, modules);
registerChannelRoutes(router, config, modules);
registerOnboardingRoutes(router, config, modules);
if (gatewayInstance) {
  registerGatewayRoutes(router, config, modules);
}
if (knowledgeGraph) {
  registerKnowledgeRoutes(router, config, modules);
}
if (tenantManager) {
  registerTenantRoutes(router, config, modules);
}
registerTaskRoutes(router, config, modules);
registerWebhookRoutes(router, config, modules);
registerClaudeRoutes(router, config, modules);
registerSkillsHubRoutes(router, config, modules);
registerEvaluationRoutes(router, config, modules);
registerUpdaterRoutes(router, config, modules);
registerSchedulerRoutes(router, config, modules);
registerUserRoutes(router, config, modules);
registerProjectRoutes(router, config, modules);
registerConfigRoutes(router, config, modules);
registerSecurityRoutes(router, config, modules);

// Start scheduler tick loop
scheduler.start();

// Webhook dispatch: auto-dispatch events to registered webhooks
events.subscribe({}, (event) => {
  try { webhookManager.dispatch(event.type, event); } catch { /* ignore dispatch errors */ }
});

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ClawCC-NodeId,X-ClawCC-Timestamp,X-ClawCC-Nonce,X-ClawCC-Signature,X-API-Key,Authorization');
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
  console.log('  Fleet Control Center');
  console.log('  Mode: ' + (config.mode || 'local'));
  console.log('  Listening: ' + config.host + ':' + config.port);
  console.log('  UI: ' + proto + '://localhost:' + config.port);
  console.log('  Pocket: ' + proto + '://localhost:' + config.port + '/pocket/');
  console.log('  Data: ' + config.dataDir);
  if (gatewayInstance) console.log('  Gateway: enabled (' + gatewayInstance.listUpstreams().length + ' upstreams)');
  console.log('');
  // Start periodic update checks
  updater.startPeriodicCheck((config.updater && config.updater.checkIntervalMs) || 21600000);
  // Start gateway health checks after server is listening
  if (gatewayInstance) {
    const gwInterval = (config.gateway && config.gateway.healthCheckIntervalMs) || 30000;
    gatewayInstance.startHealthChecks(gwInterval);
  }
});

// Periodic snapshot rebuild
const snapshotIntervalMs = (config.events && config.events.snapshotIntervalMs) || 60000;
const snapshotRebuildInterval = setInterval(() => {
  try { snapshotsMod.rebuild(config.dataDir); } catch { /* ignore */ }
}, snapshotIntervalMs);

// Periodic agent stale check (every 60s)
const agentStaleInterval = setInterval(() => {
  try { agentTracker.markStale(); } catch { /* ignore */ }
}, 60000);

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
  // Stop gateway health checks
  if (gatewayInstance) {
    try { gatewayInstance.stopHealthChecks(); } catch { /* ignore */ }
  }
  // Clear snapshot rebuild interval
  clearInterval(snapshotRebuildInterval);
  // Clear agent stale check interval and persist
  clearInterval(agentStaleInterval);
  try { agentTracker.destroy(); } catch { /* ignore */ }
  // Stop update checker
  try { updater.stopPeriodicCheck(); } catch { /* ignore */ }
  // Stop scheduler tick loop
  try { scheduler.stop(); } catch { /* ignore */ }
  // Stop Claude Code file watcher
  try { claudeIntegration.stopWatching(); } catch { /* ignore */ }
  // Flush project manager debounced writes
  try { projectManager.destroy(); } catch { /* ignore */ }
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
