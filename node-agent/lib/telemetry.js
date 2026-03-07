'use strict';
const os = require('os');
const { execSync } = require('child_process');

function collectHealth() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let cpuUsage = 0;
  if (cpus.length > 0) {
    cpuUsage = Math.round(cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return acc + (1 - cpu.times.idle / total) * 100;
    }, 0) / cpus.length);
  }

  let disk = { total: 0, used: 0, free: 0, percent: 0 };
  try {
    const { execFileSync } = require('child_process');
    const dfOutput = execFileSync('df', ['-k', '/'], { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = dfOutput.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10) * 1024;
      const used = parseInt(parts[2], 10) * 1024;
      const free = parseInt(parts[3], 10) * 1024;
      disk = { total, used, free, percent: total > 0 ? Math.round(used / total * 100) : 0 };
    }
  } catch {}

  return {
    cpu: { usage: cpuUsage, count: cpus.length, model: cpus.length > 0 ? cpus[0].model : 'unknown' },
    ram: { total: totalMem, used: totalMem - freeMem, free: freeMem, percent: Math.round((1 - freeMem / totalMem) * 100) },
    disk,
    uptime: os.uptime(),
    loadAvg: os.loadavg(),
    platform: os.platform(),
    hostname: os.hostname(),
    arch: os.arch()
  };
}

function collectProcessHealth(processName) {
  try {
    const { execFileSync } = require('child_process');
    // Use execFileSync to avoid shell injection — processName is passed as an argument, not interpolated
    const output = execFileSync('pgrep', ['-f', processName], { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const pid = parseInt(output.trim().split('\n')[0], 10);
    if (isNaN(pid)) return null;
    return { pid, running: true };
  } catch {
    return null;
  }
}

function startHealthCollection(intervalMs) {
  intervalMs = intervalMs || 5000;
  const maxEntries = Math.ceil(86400000 / intervalMs); // 24h worth
  const history = [];

  const timer = setInterval(() => {
    const health = collectHealth();
    history.push({
      ts: new Date().toISOString(),
      cpu: health.cpu.usage,
      ram: health.ram.percent,
      disk: health.disk.percent,
      loadAvg: health.loadAvg
    });
    if (history.length > maxEntries) history.shift();
  }, intervalMs);

  return {
    stop() { clearInterval(timer); },
    getHistory(minutes) {
      minutes = minutes || 60;
      const cutoff = Date.now() - minutes * 60000;
      return history.filter(h => new Date(h.ts).getTime() >= cutoff);
    },
    getCurrent() { return collectHealth(); }
  };
}

module.exports = { collectHealth, collectProcessHealth, startHealthCollection };
