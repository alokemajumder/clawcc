'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

function discoverSessions(configuredPaths) {
  const sessions = [];
  const searchPaths = (configuredPaths || ['~/.claude']).map(expandHome);

  for (const basePath of searchPaths) {
    try {
      const projectsDir = path.join(basePath, 'projects');
      if (fs.existsSync(projectsDir)) {
        const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const sessionDir = path.join(projectsDir, entry.name);
            try {
              const files = fs.readdirSync(sessionDir);
              const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
              for (const jf of jsonlFiles) {
                const filePath = path.join(sessionDir, jf);
                const stat = fs.statSync(filePath);
                sessions.push({
                  id: path.basename(jf, '.jsonl'),
                  project: entry.name,
                  path: filePath,
                  size: stat.size,
                  lastModified: stat.mtime.toISOString()
                });
              }
            } catch { /* skip unreadable dirs */ }
          }
        }
      }
    } catch { /* skip missing paths */ }
  }
  return sessions;
}

// Redact lines that look like they contain secrets/tokens/keys
const SECRET_PATTERN = /(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[:=]/i;
const MAX_CONTENT_SIZE = 64 * 1024; // 64KB per file

function redactContent(content) {
  if (!content) return content;
  if (content.length > MAX_CONTENT_SIZE) content = content.slice(0, MAX_CONTENT_SIZE) + '\n[TRUNCATED]';
  return content.split('\n').map(line =>
    SECRET_PATTERN.test(line) ? line.replace(/[:=].*/,': [REDACTED]') : line
  ).join('\n');
}

function discoverMemory(configuredPaths) {
  const searchPaths = (configuredPaths || ['~/.claude']).map(expandHome);
  const result = { memoryMd: null, heartbeatMd: null, dailyNotes: [] };
  const maxDailyNotes = 100;

  for (const basePath of searchPaths) {
    const memPath = path.join(basePath, 'MEMORY.md');
    const hbPath = path.join(basePath, 'HEARTBEAT.md');
    try { if (fs.existsSync(memPath)) result.memoryMd = redactContent(fs.readFileSync(memPath, 'utf8')); } catch {}
    try { if (fs.existsSync(hbPath)) result.heartbeatMd = redactContent(fs.readFileSync(hbPath, 'utf8')); } catch {}

    try {
      const memoryDir = path.join(basePath, 'memory');
      if (fs.existsSync(memoryDir)) {
        const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        for (const f of files) {
          if (result.dailyNotes.length >= maxDailyNotes) break;
          try {
            result.dailyNotes.push({
              name: f,
              path: path.join(memoryDir, f),
              content: redactContent(fs.readFileSync(path.join(memoryDir, f), 'utf8'))
            });
          } catch {}
        }
      }
    } catch {}
  }
  return result;
}

function discoverGitActivity(repoPath) {
  const cwd = repoPath || process.cwd();
  try {
    const log = execSync('git log --oneline -20', { cwd, timeout: 5000, encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf8' }).trim();
    const branch = execSync('git branch --show-current', { cwd, timeout: 5000, encoding: 'utf8' }).trim();
    let remote = '';
    try {
      remote = execSync('git remote get-url origin', { cwd, timeout: 5000, encoding: 'utf8' }).trim();
      // Strip embedded credentials from HTTPS URLs (e.g., https://user:token@github.com/...)
      remote = remote.replace(/\/\/[^@]+@/, '//');
    } catch {}

    return {
      recentCommits: log.split('\n').filter(Boolean),
      dirtyState: status.length > 0,
      dirtyFiles: status.split('\n').filter(Boolean),
      branch,
      remote
    };
  } catch {
    return null;
  }
}

function discoverCronJobs() {
  const jobs = [];
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
    const lines = crontab.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length >= 6) {
        const command = parts.slice(5).join(' ');
        jobs.push({
          id: 'cron-' + i,
          schedule: parts.slice(0, 5).join(' '),
          command: SECRET_PATTERN.test(command) ? '[REDACTED]' : command,
          source: 'crontab',
          enabled: true
        });
      }
    }
  } catch {}

  // Check launchd on macOS
  if (os.platform() === 'darwin') {
    const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    try {
      if (fs.existsSync(launchDir)) {
        const plists = fs.readdirSync(launchDir).filter(f => f.endsWith('.plist'));
        for (const plist of plists) {
          jobs.push({
            id: 'launchd-' + path.basename(plist, '.plist'),
            schedule: 'launchd',
            command: plist,
            source: 'launchd',
            enabled: true,
            path: path.join(launchDir, plist)
          });
        }
      }
    } catch {}
  }
  return jobs;
}

function discoverTailscale() {
  try {
    const output = execSync('tailscale status --json', { timeout: 10000, encoding: 'utf8' });
    const data = JSON.parse(output);
    const peers = [];
    const maxPeers = 500;
    if (data.Peer) {
      for (const [key, peer] of Object.entries(data.Peer)) {
        if (peers.length >= maxPeers) break;
        peers.push({
          id: key,
          hostname: peer.HostName,
          ip: peer.TailscaleIPs ? peer.TailscaleIPs[0] : null,
          online: peer.Online,
          os: peer.OS
        });
      }
    }
    return {
      status: data.BackendState || 'Unknown',
      hostname: data.Self ? data.Self.HostName : os.hostname(),
      ip: data.Self && data.Self.TailscaleIPs ? data.Self.TailscaleIPs[0] : null,
      version: data.Version || '',
      peers
    };
  } catch {
    return null;
  }
}

module.exports = { discoverSessions, discoverMemory, discoverGitActivity, discoverCronJobs, discoverTailscale };
