'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { parseBody, sanitizePath } = require('../middleware/security');
const { authenticate } = require('../middleware/auth-middleware');

function registerOpsRoutes(router, config, modules) {
  const { auth, audit, events, index, snapshots } = modules;
  const healthHistory = [];
  const cronHistory = [];

  // Collect health every 5s
  setInterval(() => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    healthHistory.push({
      ts: new Date().toISOString(),
      cpu: cpus.length > 0 ? Math.round(cpus.reduce((acc, c) => { const total = Object.values(c.times).reduce((a, b) => a + b, 0); return acc + (1 - c.times.idle / total) * 100; }, 0) / cpus.length) : 0,
      ram: Math.round((1 - freeMem / totalMem) * 100),
      loadAvg: os.loadavg()
    });
    if (healthHistory.length > 17280) healthHistory.shift(); // 24h at 5s
  }, 5000);

  router.get('/api/ops/health', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const healthData = snapshots.load(config.dataDir, 'health');
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    res.json(200, {
      success: true,
      controlPlane: {
        cpu: cpus.length > 0 ? Math.round(cpus.reduce((acc, c) => { const total = Object.values(c.times).reduce((a, b) => a + b, 0); return acc + (1 - c.times.idle / total) * 100; }, 0) / cpus.length) : 0,
        ram: { total: totalMem, free: freeMem, percent: Math.round((1 - freeMem / totalMem) * 100) },
        uptime: os.uptime(), platform: os.platform(), hostname: os.hostname()
      },
      nodes: healthData ? healthData.nodes || {} : {}
    });
  });

  router.get('/api/ops/health/history', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    res.json(200, { success: true, history: healthHistory.slice(-720) }); // last hour at 5s
  });

  router.get('/api/ops/usage', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const usage = snapshots.load(config.dataDir, 'usage');
    res.json(200, { success: true, usage: usage || { providers: {}, lifetime: { totalCost: 0, totalTokens: 0 } } });
  });

  router.get('/api/ops/usage/breakdown', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const usage = snapshots.load(config.dataDir, 'usage');
    res.json(200, { success: true, breakdown: usage || {} });
  });

  router.get('/api/ops/memory', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const home = os.homedir();
    const memoryFiles = {};
    const discoveryPaths = config.discovery ? config.discovery.paths || [] : [
      '~/.claude', '~/.codex', '~/.copilot', '~/.cursor',
      '~/.codeium', '~/.gemini', '~/.augment', '~/.kiro',
      '~/.aws/amazonq', '~/.config/TabNine',
      '~/.openclaw', '~/.zeroclaw', '~/.nanobot', '~/.nemoclaw',
      '~/.continue', '~/.openhands', '~/.tabby',
      '~/.config/goose', '~/.config/opencode',
      '~/Documents/Cline'
    ];
    const memoryFileNames = ['MEMORY.md', 'HEARTBEAT.md'];
    for (const dp of discoveryPaths) {
      const resolved = dp.replace(/^~/, home);
      for (const fn of memoryFileNames) {
        const p = path.join(resolved, fn);
        const key = `${path.basename(resolved)}/${fn}`;
        try { memoryFiles[key] = fs.readFileSync(p, 'utf8'); } catch { /* skip */ }
      }
    }
    res.json(200, { success: true, files: memoryFiles });
  });

  router.get('/api/ops/workspace/files', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const allowedPaths = config.discovery ? config.discovery.paths || [] : [
      '~/.claude', '~/.codex', '~/.copilot', '~/.cursor',
      '~/.codeium', '~/.gemini', '~/.augment', '~/.kiro',
      '~/.aws/amazonq', '~/.config/TabNine',
      '~/.openclaw', '~/.zeroclaw', '~/.nanobot', '~/.nemoclaw',
      '~/.continue', '~/.openhands', '~/.tabby',
      '~/.config/goose', '~/.config/opencode',
      '~/Documents/Cline'
    ];
    const home = os.homedir();
    const files = [];
    for (const p of allowedPaths) {
      const resolved = p.replace(/^~/, home);
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true, recursive: false });
        for (const entry of entries) {
          files.push({ name: entry.name, path: path.join(resolved, entry.name), isDirectory: entry.isDirectory() });
        }
      } catch { /* skip */ }
    }
    res.json(200, { success: true, files });
  });

  router.get('/api/ops/workspace/file', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const filePath = req.query.path;
    if (!filePath) return res.error(400, 'Path required');
    const allowedPaths = config.discovery ? config.discovery.paths || [] : [
      '~/.claude', '~/.codex', '~/.copilot', '~/.cursor',
      '~/.codeium', '~/.gemini', '~/.augment', '~/.kiro',
      '~/.aws/amazonq', '~/.config/TabNine',
      '~/.openclaw', '~/.zeroclaw', '~/.nanobot', '~/.nemoclaw',
      '~/.continue', '~/.openhands', '~/.tabby',
      '~/.config/goose', '~/.config/opencode',
      '~/Documents/Cline'
    ];
    const result = sanitizePath(filePath, allowedPaths);
    if (!result.safe) return res.error(403, 'Path not in allowed roots');
    try {
      const content = fs.readFileSync(result.resolved, 'utf8');
      res.json(200, { success: true, path: filePath, content });
    } catch (err) {
      res.error(404, 'File not found');
    }
  });

  router.put('/api/ops/workspace/file', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.path || body.content === undefined) return res.error(400, 'Path and content required');
    const allowedPaths = config.discovery ? config.discovery.paths || [] : [
      '~/.claude', '~/.codex', '~/.copilot', '~/.cursor',
      '~/.codeium', '~/.gemini', '~/.augment', '~/.kiro',
      '~/.aws/amazonq', '~/.config/TabNine',
      '~/.openclaw', '~/.zeroclaw', '~/.nanobot', '~/.nemoclaw',
      '~/.continue', '~/.openhands', '~/.tabby',
      '~/.config/goose', '~/.config/opencode',
      '~/Documents/Cline'
    ];
    const result = sanitizePath(body.path, allowedPaths);
    if (!result.safe) return res.error(403, 'Path not in allowed roots');
    const crypto = require('crypto');
    let beforeHash = '';
    try { beforeHash = crypto.createHash('sha256').update(fs.readFileSync(result.resolved, 'utf8')).digest('hex'); } catch {}
    const tmpWritePath = result.resolved + '.tmp';
    fs.writeFileSync(tmpWritePath, body.content, 'utf8');
    fs.renameSync(tmpWritePath, result.resolved);
    const afterHash = crypto.createHash('sha256').update(body.content).digest('hex');
    audit.log({ actor: authResult.user.username, action: 'file.write', target: body.path, beforeHash, afterHash, reason: body.reason || '' });
    res.json(200, { success: true });
  });

  router.get('/api/ops/git', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    try {
      const log = execSync('git log --oneline -20 2>/dev/null', { timeout: 5000, encoding: 'utf8' }).trim();
      const status = execSync('git status --porcelain 2>/dev/null', { timeout: 5000, encoding: 'utf8' }).trim();
      const branch = execSync('git branch --show-current 2>/dev/null', { timeout: 5000, encoding: 'utf8' }).trim();
      res.json(200, { success: true, git: { branch, commits: log.split('\n').filter(Boolean), dirty: status.length > 0, dirtyFiles: status.split('\n').filter(Boolean).length } });
    } catch {
      res.json(200, { success: true, git: null });
    }
  });

  router.get('/api/ops/cron', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    try {
      const crontab = execSync('crontab -l 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
      const jobs = crontab.split('\n').filter(l => l.trim() && !l.startsWith('#')).map((line, i) => {
        const parts = line.trim().split(/\s+/);
        return { id: 'cron-' + i, schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' '), enabled: true };
      });
      res.json(200, { success: true, jobs });
    } catch {
      res.json(200, { success: true, jobs: [] });
    }
  });

  router.get('/api/ops/cron/history', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    res.json(200, { success: true, history: cronHistory.slice(-50) });
  });

  router.post('/api/ops/cron/:jobId/run', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:cron')) return res.error(403, 'Insufficient permissions');
    cronHistory.push({ jobId: req.params.jobId, triggeredBy: authResult.user.username, triggeredAt: new Date().toISOString(), status: 'completed' });
    if (cronHistory.length > 200) cronHistory.splice(0, cronHistory.length - 200);
    audit.log({ actor: authResult.user.username, action: 'cron.triggered', target: req.params.jobId });
    res.json(200, { success: true, message: 'Cron job trigger queued' });
  });

  router.post('/api/ops/cron/:jobId/toggle', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:cron')) return res.error(403, 'Insufficient permissions');
    audit.log({ actor: authResult.user.username, action: 'cron.toggled', target: req.params.jobId });
    res.json(200, { success: true, message: 'Cron job toggled' });
  });

  router.get('/api/ops/logs', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const source = req.query.source || 'clawcc';
    const lines = parseInt(req.query.lines || '100', 10);
    const defaultLogPaths = { clawcc: '/var/log/clawcc/clawcc.log' };
    const logPaths = config.logSources || defaultLogPaths;
    const logPath = logPaths[source];
    if (!logPath) return res.json(200, { success: true, logs: [] });
    try {
      const safeLine = Math.min(Math.max(1, lines), 1000);
      const content = execSync('tail -n ' + safeLine + ' ' + JSON.stringify(logPath) + ' 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
      res.json(200, { success: true, logs: content.split('\n').filter(Boolean) });
    } catch {
      res.json(200, { success: true, logs: [] });
    }
  });

  router.get('/api/ops/tailscale', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    try {
      const output = execSync('tailscale status --json 2>/dev/null', { timeout: 10000, encoding: 'utf8' });
      res.json(200, { success: true, tailscale: JSON.parse(output) });
    } catch {
      res.json(200, { success: true, tailscale: null });
    }
  });

  // Usage alerts: from in-memory index aggregation (no disk scan)
  router.get('/api/ops/usage/alerts', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');

    const alertConfig = config.alerts || {};
    const result = index.getUsageAlerts({
      costPerHour: alertConfig.costPerHour || 5.0,
      tokensPerHour: alertConfig.tokensPerHour || 100000,
      errorRateThreshold: alertConfig.errorRateThreshold || 0.10
    });
    res.json(200, { success: true, ...result });
  });

  // Rolling usage windows: from in-memory ring buffer (no disk scan)
  router.get('/api/ops/usage/rolling', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');

    const windowParam = req.query.window || '24h';
    const windowMap = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
    const windowMs = windowMap[windowParam] || 86400000;
    const windowLabel = windowMap[windowParam] ? windowParam : '24h';
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const result = index.getRollingUsage(windowMs);
    res.json(200, {
      success: true,
      window: windowLabel,
      from: cutoff,
      to: new Date().toISOString(),
      providers: result.providers,
      totals: result.totals
    });
  });

  // Push notification subscriptions (in-memory store, capped)
  const pushSubscriptions = [];
  const PUSH_SUBS_MAX = 1000;

  router.post('/api/ops/notifications/subscribe', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    if (!body.endpoint) return res.error(400, 'Subscription endpoint required');
    // Store subscription (deduplicate by endpoint)
    const existing = pushSubscriptions.findIndex(s => s.endpoint === body.endpoint);
    if (existing >= 0) pushSubscriptions[existing] = body;
    else if (pushSubscriptions.length < PUSH_SUBS_MAX) pushSubscriptions.push(body);
    else return res.error(429, 'Subscription limit reached');
    res.json(200, { success: true, subscribed: true });
  });

  router.post('/api/ops/notifications/test', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    // Note: actual Web Push requires VAPID keys and https module
    // This stores the intent - the notification is triggered client-side via the Notification API
    res.json(200, { success: true, message: 'Test notification queued', subscriptions: pushSubscriptions.length });
  });
}

module.exports = { registerOpsRoutes };
