'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function init(spoolDir, options = {}) {
  fs.mkdirSync(spoolDir, { recursive: true });
  const maxSpoolBytes = options.maxSpoolBytes || 100 * 1024 * 1024; // 100MB default
  let draining = false;

  return {
    spool(event) {
      // Enforce spool size limit to prevent disk exhaustion
      try {
        const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.jsonl'));
        let totalBytes = 0;
        for (const f of files) {
          totalBytes += fs.statSync(path.join(spoolDir, f)).size;
        }
        if (totalBytes >= maxSpoolBytes) {
          // Drop oldest file to make room
          const sorted = files.sort();
          if (sorted.length > 0) {
            fs.unlinkSync(path.join(spoolDir, sorted[0]));
          }
        }
      } catch { /* best effort */ }

      const date = new Date().toISOString().slice(0, 10);
      const filePath = path.join(spoolDir, date + '.jsonl');
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    },

    async drain(controlPlaneUrl, nodeSecret) {
      if (draining) return { sent: 0, failed: 0, remaining: 0, skipped: true };
      draining = true;
      try { return await this._doDrain(controlPlaneUrl, nodeSecret); }
      finally { draining = false; }
    },

    async _doDrain(controlPlaneUrl, nodeSecret) {
      const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.jsonl')).sort();
      let sent = 0, failed = 0;

      for (const file of files) {
        const filePath = path.join(spoolDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        const remaining = [];

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            const success = await sendEvent(controlPlaneUrl, event, nodeSecret);
            if (success) sent++;
            else { remaining.push(line); failed++; }
          } catch (err) {
            // Only re-spool if it's valid JSON that failed to send (network error).
            // Drop permanently corrupted lines to prevent infinite retry.
            try { JSON.parse(line); remaining.push(line); } catch { /* corrupted line, discard */ }
            failed++;
          }
        }

        if (remaining.length === 0) {
          fs.unlinkSync(filePath);
        } else {
          // Atomic write: write to temp file then rename to prevent data loss on crash
          const tmpPath = filePath + '.tmp';
          fs.writeFileSync(tmpPath, remaining.join('\n') + '\n');
          fs.renameSync(tmpPath, filePath);
        }
      }

      return { sent, failed, remaining: failed };
    },

    getSpoolSize() {
      const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.jsonl'));
      let totalBytes = 0;
      let oldestEvent = null;

      for (const file of files) {
        const stat = fs.statSync(path.join(spoolDir, file));
        totalBytes += stat.size;
        if (!oldestEvent || file < oldestEvent) oldestEvent = file.replace('.jsonl', '');
      }

      return { files: files.length, totalBytes, oldestEvent };
    },

    cleanup(maxAgeDays) {
      maxAgeDays = maxAgeDays || 7;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - maxAgeDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.jsonl'));
      let removed = 0;
      for (const file of files) {
        if (file.replace('.jsonl', '') < cutoffStr) {
          fs.unlinkSync(path.join(spoolDir, file));
          removed++;
        }
      }
      return { removed };
    }
  };
}

function sendEvent(baseUrl, event, nodeSecret) {
  return new Promise((resolve) => {
    const url = new URL('/api/events/ingest', baseUrl);
    const data = JSON.stringify(event);
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const hmac = crypto.createHmac('sha256', nodeSecret);
    hmac.update('POST\n/api/events/ingest\n' + timestamp + '\n' + data);
    const signature = hmac.digest('hex');

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-ClawCC-Timestamp': timestamp,
        'X-ClawCC-Nonce': nonce,
        'X-ClawCC-Signature': signature
      }
    };

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let body = '';
      const maxResponseBytes = 65536;
      res.on('data', c => {
        if (body.length < maxResponseBytes) body += c;
        else res.destroy(); // discard oversized responses
      });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

module.exports = { init };
