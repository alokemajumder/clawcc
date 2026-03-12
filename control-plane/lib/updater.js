'use strict';

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Compare two semver strings numerically.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * Make an HTTP(S) GET request and return the response body as a string.
 */
function httpGet(url, timeoutMs = 10000, _redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    if (_redirectCount >= MAX_REDIRECTS) {
      return reject(new Error('Too many redirects (max ' + MAX_REDIRECTS + ')'));
    }
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'FCC-Updater/1.0', 'Accept': 'application/vnd.github+json' },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect with counter
        httpGet(res.headers.location, timeoutMs, _redirectCount + 1).then(resolve, reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        } else {
          resolve(data);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Factory: createUpdater(opts)
 *
 * opts.projectRoot - path to the repository root (parent of control-plane/)
 * opts.apiUrl      - override GitHub API base URL (for testing)
 * opts.checkIntervalMs - periodic check interval (default 6h)
 */
function createUpdater(opts = {}) {
  const projectRoot = opts.projectRoot || path.resolve(__dirname, '..', '..');
  const apiUrl = opts.apiUrl || 'https://api.github.com/repos/alokemajumder/FleetControlCenter/releases/latest';
  const cacheTtlMs = opts.cacheTtlMs || 3600000; // 1 hour

  let cachedStatus = null;   // { result, checkedAt }
  let periodicTimer = null;

  function getCurrentVersion() {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  }

  async function checkForUpdates() {
    // Use cache if fresh
    if (cachedStatus && (Date.now() - cachedStatus.checkedAt) < cacheTtlMs) {
      return cachedStatus.result;
    }

    const currentVersion = getCurrentVersion();

    try {
      const body = await httpGet(apiUrl);
      const release = JSON.parse(body);
      const tagName = release.tag_name || release.name || '';
      const latestVersion = tagName.replace(/^v/, '');
      const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
      const result = {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseUrl: release.html_url || '',
        releaseNotes: release.body || '',
        publishedAt: release.published_at || null
      };
      cachedStatus = { result, checkedAt: Date.now() };
      return result;
    } catch (err) {
      const result = {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
        error: err.message
      };
      cachedStatus = { result, checkedAt: Date.now() };
      return result;
    }
  }

  function getUpdateStatus() {
    if (!cachedStatus) {
      return { checked: false, result: null };
    }
    return { checked: true, checkedAt: cachedStatus.checkedAt, result: cachedStatus.result };
  }

  function getVersionHistory() {
    // Return what we know from cache; no separate API call
    const currentVersion = getCurrentVersion();
    const versions = [{ version: currentVersion, current: true }];
    if (cachedStatus && cachedStatus.result && cachedStatus.result.latestVersion) {
      const lv = cachedStatus.result.latestVersion;
      if (lv !== currentVersion) {
        versions.push({
          version: lv,
          current: false,
          publishedAt: cachedStatus.result.publishedAt
        });
      }
    }
    return versions;
  }

  function canSelfUpdate() {
    // Check 1: .git directory exists
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      return { canUpdate: false, reason: 'Not a git repository' };
    }

    // Check 2: git binary available
    try {
      execSync('git --version', { stdio: 'pipe', cwd: projectRoot });
    } catch {
      return { canUpdate: false, reason: 'git is not available' };
    }

    // Check 3: working tree clean
    try {
      const status = execSync('git status --porcelain', { stdio: 'pipe', cwd: projectRoot, encoding: 'utf8' });
      if (status.trim().length > 0) {
        return { canUpdate: false, reason: 'Working tree has uncommitted changes' };
      }
    } catch {
      return { canUpdate: false, reason: 'Cannot check git status' };
    }

    return { canUpdate: true, reason: null };
  }

  function performUpdate() {
    const check = canSelfUpdate();
    if (!check.canUpdate) {
      return { success: false, error: check.reason, previousVersion: getCurrentVersion(), newVersion: null, output: null };
    }

    const previousVersion = getCurrentVersion();
    try {
      const output = execSync('git pull origin main', { stdio: 'pipe', cwd: projectRoot, encoding: 'utf8', timeout: 60000 });
      const newVersion = getCurrentVersion();
      // Invalidate cache so next check picks up new version
      cachedStatus = null;
      return { success: true, previousVersion, newVersion, output: output.trim() };
    } catch (err) {
      return { success: false, previousVersion, newVersion: null, output: err.message, error: 'git pull failed' };
    }
  }

  function getChangelog() {
    const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) {
      return { found: false, content: null, entries: [] };
    }
    const content = fs.readFileSync(changelogPath, 'utf8');
    // Parse sections: ## [version] or ## version
    const entries = [];
    const sectionRegex = /^##\s+\[?([^\]\n]+)\]?/gm;
    let match;
    const positions = [];
    while ((match = sectionRegex.exec(content)) !== null) {
      positions.push({ version: match[1].trim(), start: match.index });
    }
    for (let i = 0; i < positions.length; i++) {
      const end = i + 1 < positions.length ? positions[i + 1].start : content.length;
      const body = content.slice(positions[i].start, end).trim();
      entries.push({ version: positions[i].version, body });
    }
    return { found: true, content, entries };
  }

  function startPeriodicCheck(intervalMs) {
    const interval = intervalMs || opts.checkIntervalMs || 21600000; // 6 hours
    stopPeriodicCheck();
    // Do an initial check
    checkForUpdates().catch(() => { /* ignore */ });
    periodicTimer = setInterval(() => {
      checkForUpdates().catch(() => { /* ignore */ });
    }, interval);
    // Unref so it doesn't keep process alive
    if (periodicTimer && periodicTimer.unref) periodicTimer.unref();
  }

  function stopPeriodicCheck() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return {
    getCurrentVersion,
    checkForUpdates,
    getUpdateStatus,
    getVersionHistory,
    canSelfUpdate,
    performUpdate,
    getChangelog,
    startPeriodicCheck,
    stopPeriodicCheck,
    // Exported for testing
    _compareSemver: compareSemver,
    _clearCache() { cachedStatus = null; }
  };
}

module.exports = { createUpdater, compareSemver };
