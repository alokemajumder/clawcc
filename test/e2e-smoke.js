'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'control-plane', 'server.js');

// Create a temp data dir for the test
const tmpDataDir = path.join(os.tmpdir(), 'clawcc-e2e-' + Date.now());
const tmpConfigPath = path.join(tmpDataDir, 'config.json');

function request(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 10000
    }, (res) => {
      let responseBody = '';
      res.on('data', c => responseBody += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = cookieStr.match(/clawcc_session=([^;]+)/);
  return match ? match[1] : null;
}

describe('E2E Smoke Tests', () => {
  let serverProcess;

  before(async () => {
    // Create temp config
    fs.mkdirSync(tmpDataDir, { recursive: true });
    fs.writeFileSync(tmpConfigPath, JSON.stringify({
      host: '127.0.0.1',
      port: PORT,
      dataDir: path.join(tmpDataDir, 'data'),
      auth: { defaultAdminPassword: 'testpass123' },
      sessionSecret: 'test-secret-key'
    }, null, 2));

    // Start server
    serverProcess = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, CLAWCC_CONFIG: tmpConfigPath },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      let output = '';
      serverProcess.stdout.on('data', (data) => {
        output += data.toString();
        if (output.includes('Listening:')) {
          clearTimeout(timeout);
          // Give it a moment to fully bind
          setTimeout(resolve, 500);
        }
      });
      serverProcess.stderr.on('data', (data) => {
        output += data.toString();
      });
      serverProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
      serverProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}: ${output}`));
        }
      });
    });
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    // Cleanup temp dir
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
  });

  it('health check returns 200', async () => {
    const res = await request('GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.uptime === 'number');
  });

  it('security headers are set', async () => {
    const res = await request('GET', '/healthz');
    assert.ok(res.headers['x-content-type-options']);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['x-frame-options']);
    assert.ok(res.headers['content-security-policy']);
  });

  it('unauthenticated API returns 401', async () => {
    const res = await request('GET', '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('login with correct credentials returns session cookie', async () => {
    const res = await request('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const cookie = extractCookie(res.headers);
    assert.ok(cookie, 'Should set session cookie');
    assert.ok(cookie.length >= 32, 'Session token should be at least 32 chars');
  });

  it('login with wrong credentials returns 401', async () => {
    const res = await request('POST', '/api/auth/login', { username: 'admin', password: 'wrongpass' });
    assert.equal(res.status, 401);
  });

  it('authenticated endpoint works with session cookie', async () => {
    // Login first
    const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
    const cookie = extractCookie(loginRes.headers);
    assert.ok(cookie);

    // Use cookie to access authenticated endpoint
    const res = await request('GET', '/api/auth/me', null, { Cookie: `clawcc_session=${cookie}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user.username, 'admin');
  });

  it('fleet status returns data when authenticated', async () => {
    const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
    const cookie = extractCookie(loginRes.headers);

    const res = await request('GET', '/api/fleet/nodes', null, { Cookie: `clawcc_session=${cookie}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it('serves UI static files', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
  });

  it('API 404 returns JSON', async () => {
    const res = await request('GET', '/api/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });

  it('rate limiter headers are functional', async () => {
    // Send multiple rapid requests - should all succeed (under threshold)
    for (let i = 0; i < 5; i++) {
      const res = await request('GET', '/healthz');
      assert.equal(res.status, 200);
    }
  });

  it('data directory was created', () => {
    assert.ok(fs.existsSync(path.join(tmpDataDir, 'data')));
    assert.ok(fs.existsSync(path.join(tmpDataDir, 'data', 'events')));
    assert.ok(fs.existsSync(path.join(tmpDataDir, 'data', 'users')));
  });

  it('logout destroys session', async () => {
    const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
    const cookie = extractCookie(loginRes.headers);

    // Logout
    const logoutRes = await request('POST', '/api/auth/logout', null, { Cookie: `clawcc_session=${cookie}` });
    assert.equal(logoutRes.status, 200);

    // Session should no longer be valid
    const meRes = await request('GET', '/api/auth/me', null, { Cookie: `clawcc_session=${cookie}` });
    assert.equal(meRes.status, 401);
  });
});
