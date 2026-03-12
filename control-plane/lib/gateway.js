'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const MAX_UPSTREAMS = 200;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_HEALTH_INTERVAL_MS = 30000;
const UNHEALTHY_THRESHOLD = 3;

function createGateway(opts = {}) {
  const dataDir = opts.dataDir || null;
  const upstreams = new Map(); // id -> upstream config + health
  const healthInterval = { ref: null };

  // Persistence path
  const gatewayDir = dataDir ? path.join(dataDir, 'gateway') : null;
  const upstreamsFile = gatewayDir ? path.join(gatewayDir, 'upstreams.json') : null;

  // Load persisted upstreams
  function loadFromDisk() {
    if (!upstreamsFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(upstreamsFile, 'utf8'));
      if (Array.isArray(data)) {
        for (const u of data) {
          if (u && u.id) {
            upstreams.set(u.id, {
              ...u,
              _health: { status: 'unknown', lastSeen: null, latencyMs: null, consecutiveFailures: 0 }
            });
          }
        }
      }
    } catch { /* file doesn't exist or is corrupt */ }
  }

  // Persist upstreams to disk
  function saveToDisk() {
    if (!gatewayDir || !upstreamsFile) return;
    try {
      fs.mkdirSync(gatewayDir, { recursive: true });
      const data = [];
      for (const [, u] of upstreams) {
        // Strip health info from persisted data
        const { _health, ...rest } = u;
        data.push(rest);
      }
      const tmp = upstreamsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, upstreamsFile);
    } catch { /* ignore write errors */ }
  }

  // Validate upstream config
  function validateUpstream(config) {
    if (!config.id || typeof config.id !== 'string') return 'id is required and must be a string';
    if (!config.url || typeof config.url !== 'string') return 'url is required and must be a string';
    if (!config.name || typeof config.name !== 'string') return 'name is required and must be a string';
    // Validate URL
    try {
      const parsed = new URL(config.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url must use http or https protocol';
    } catch {
      return 'url is not a valid URL';
    }
    return null;
  }

  function addUpstream(config) {
    const err = validateUpstream(config);
    if (err) throw new Error(err);
    if (upstreams.size >= MAX_UPSTREAMS) throw new Error('Maximum upstream limit reached (' + MAX_UPSTREAMS + ')');
    if (upstreams.has(config.id)) throw new Error('Upstream already exists: ' + config.id);

    const upstream = {
      id: config.id,
      name: config.name,
      url: config.url.replace(/\/+$/, ''), // strip trailing slashes
      hmacSecret: config.hmacSecret || null,
      enabled: config.enabled !== false,
      addedAt: new Date().toISOString(),
      _health: { status: 'unknown', lastSeen: null, latencyMs: null, consecutiveFailures: 0 }
    };
    upstreams.set(config.id, upstream);
    saveToDisk();
    return { ...upstream, _health: undefined };
  }

  function removeUpstream(id) {
    if (!upstreams.has(id)) throw new Error('Upstream not found: ' + id);
    upstreams.delete(id);
    saveToDisk();
  }

  function listUpstreams() {
    const result = [];
    for (const [, u] of upstreams) {
      result.push({
        id: u.id,
        name: u.name,
        url: u.url,
        enabled: u.enabled,
        addedAt: u.addedAt,
        health: { ...u._health }
      });
    }
    return result;
  }

  function getUpstream(id) {
    const u = upstreams.get(id);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      url: u.url,
      enabled: u.enabled,
      addedAt: u.addedAt,
      hmacSecret: u.hmacSecret ? '***' : null,
      health: { ...u._health }
    };
  }

  function updateUpstream(id, config) {
    const u = upstreams.get(id);
    if (!u) throw new Error('Upstream not found: ' + id);
    if (config.name !== undefined) u.name = config.name;
    if (config.url !== undefined) {
      try {
        const parsed = new URL(config.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid protocol');
      } catch {
        throw new Error('url is not a valid URL');
      }
      u.url = config.url.replace(/\/+$/, '');
    }
    if (config.hmacSecret !== undefined) u.hmacSecret = config.hmacSecret;
    if (config.enabled !== undefined) u.enabled = !!config.enabled;
    saveToDisk();
    return { id: u.id, name: u.name, url: u.url, enabled: u.enabled };
  }

  // Make an HTTP/HTTPS request to an upstream
  function proxyRequest(upstreamId, method, reqPath, body, callback) {
    const u = upstreams.get(upstreamId);
    if (!u) {
      callback({ error: 'Upstream not found: ' + upstreamId });
      return;
    }

    const targetUrl = u.url + reqPath;
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      callback({ error: 'Invalid upstream URL' });
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'X-Gateway-Upstream': upstreamId,
      'X-Gateway-Timestamp': String(Date.now())
    };

    // HMAC signature if configured
    if (u.hmacSecret) {
      const timestamp = headers['X-Gateway-Timestamp'];
      const payload = method + ':' + reqPath + ':' + timestamp + ':' + (body ? JSON.stringify(body) : '');
      const signature = crypto.createHmac('sha256', u.hmacSecret).update(payload).digest('hex');
      headers['X-Gateway-Signature'] = signature;
    }

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers,
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS
    };

    let callbackFired = false;
    function safeCallback(result) {
      if (callbackFired) return;
      callbackFired = true;
      callback(result);
    }

    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsedBody;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
        safeCallback({ status: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      safeCallback({ error: 'Request timeout after ' + (opts.timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms' });
    });

    req.on('error', (err) => {
      safeCallback({ error: 'Request failed: ' + (err.message || String(err)) });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  }

  // Promise wrapper for proxyRequest
  function proxyRequestAsync(upstreamId, method, reqPath, body) {
    return new Promise((resolve) => {
      proxyRequest(upstreamId, method, reqPath, body, resolve);
    });
  }

  // Fan out a request to all enabled upstreams, merge results
  function aggregateRequest(method, reqPath, body) {
    const enabled = [];
    for (const [, u] of upstreams) {
      if (u.enabled) enabled.push(u.id);
    }

    if (enabled.length === 0) {
      return Promise.resolve({ results: [], errors: [], total: 0 });
    }

    const promises = enabled.map((id) => {
      return proxyRequestAsync(id, method, reqPath, body).then((result) => {
        return { upstreamId: id, ...result };
      });
    });

    return Promise.all(promises).then((results) => {
      const successes = [];
      const errors = [];
      for (const r of results) {
        if (r.error) {
          errors.push({ upstreamId: r.upstreamId, error: r.error });
        } else {
          successes.push(r);
        }
      }
      return { results: successes, errors, total: enabled.length };
    });
  }

  // Health check a single upstream
  function checkHealth(upstream) {
    return new Promise((resolve) => {
      const targetUrl = upstream.url + '/healthz';
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        upstream._health.consecutiveFailures++;
        if (upstream._health.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
          upstream._health.status = 'unhealthy';
        }
        resolve();
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const startTime = Date.now();

      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        timeout: 5000
      };

      const req = transport.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const latency = Date.now() - startTime;
          if (res.statusCode === 200) {
            upstream._health.status = 'healthy';
            upstream._health.lastSeen = new Date().toISOString();
            upstream._health.latencyMs = latency;
            upstream._health.consecutiveFailures = 0;
          } else {
            upstream._health.consecutiveFailures++;
            if (upstream._health.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
              upstream._health.status = 'unhealthy';
            }
          }
          resolve();
        });
      });

      req.on('timeout', () => {
        req.destroy();
        upstream._health.consecutiveFailures++;
        if (upstream._health.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
          upstream._health.status = 'unhealthy';
        }
        resolve();
      });

      req.on('error', () => {
        upstream._health.consecutiveFailures++;
        if (upstream._health.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
          upstream._health.status = 'unhealthy';
        }
        resolve();
      });

      req.end();
    });
  }

  function startHealthChecks(intervalMs) {
    const interval = intervalMs || DEFAULT_HEALTH_INTERVAL_MS;
    stopHealthChecks(); // clear existing
    healthInterval.ref = setInterval(() => {
      for (const [, u] of upstreams) {
        if (u.enabled) checkHealth(u);
      }
    }, interval);
    // Unref so the interval doesn't prevent process exit
    if (healthInterval.ref && healthInterval.ref.unref) healthInterval.ref.unref();
    // Run first check immediately
    for (const [, u] of upstreams) {
      if (u.enabled) checkHealth(u);
    }
  }

  function stopHealthChecks() {
    if (healthInterval.ref) {
      clearInterval(healthInterval.ref);
      healthInterval.ref = null;
    }
  }

  function getHealth() {
    const summary = { total: 0, healthy: 0, unhealthy: 0, unknown: 0, upstreams: [] };
    for (const [, u] of upstreams) {
      summary.total++;
      const status = u._health.status;
      if (status === 'healthy') summary.healthy++;
      else if (status === 'unhealthy') summary.unhealthy++;
      else summary.unknown++;
      summary.upstreams.push({
        id: u.id,
        name: u.name,
        enabled: u.enabled,
        health: { ...u._health }
      });
    }
    return summary;
  }

  // Initialize: load persisted upstreams, then overlay any from opts
  loadFromDisk();
  if (Array.isArray(opts.upstreams)) {
    for (const u of opts.upstreams) {
      if (u && u.id && !upstreams.has(u.id)) {
        try { addUpstream(u); } catch { /* skip invalid */ }
      }
    }
  }

  return {
    addUpstream,
    removeUpstream,
    listUpstreams,
    getUpstream,
    updateUpstream,
    proxyRequest: proxyRequestAsync,
    aggregateRequest,
    startHealthChecks,
    stopHealthChecks,
    getHealth,
    // Expose for testing
    _checkHealth: checkHealth,
    _upstreams: upstreams
  };
}

module.exports = { createGateway };
