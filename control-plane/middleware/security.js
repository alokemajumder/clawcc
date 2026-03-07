'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const rateLimitStores = new Map();

function securityHeaders(req, res, httpsEnabled) {
  // Generate per-request nonce for CSP
  const nonce = crypto.randomBytes(16).toString('base64');
  res.cspNonce = nonce;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'nonce-" + nonce + "'; " +
    "style-src 'self' 'nonce-" + nonce + "'; " +
    "style-src-attr 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (httpsEnabled) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function rateLimiter(windowMs, maxRequests) {
  const store = new Map();

  return function check(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = store.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      store.set(ip, entry);
    }

    entry.count++;
    const allowed = entry.count <= maxRequests;
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetAt = entry.windowStart + windowMs;

    if (store.size > 10000) {
      for (const [k, v] of store) {
        if (now - v.windowStart > windowMs) store.delete(k);
      }
    }

    return { allowed, remaining, resetAt };
  };
}

function validateContentLength(req, maxBytes = 1048576) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  return len <= maxBytes;
}

function sanitizePath(inputPath, allowedRoots) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const expanded = inputPath.replace(/^~/, home);
    const resolved = path.resolve(expanded);
    // Resolve symlinks to prevent bypass (e.g., /tmp -> /private/tmp on macOS)
    let realResolved;
    try { realResolved = fs.realpathSync(resolved); } catch { realResolved = resolved; }
    const normalizedRoots = allowedRoots.map(r => {
      const rp = path.resolve(r.replace(/^~/, home));
      try { return fs.realpathSync(rp); } catch { return rp; }
    });

    for (const root of normalizedRoots) {
      if (realResolved.startsWith(root + path.sep) || realResolved === root) {
        return { safe: true, resolved: realResolved };
      }
    }
    return { safe: false, resolved: realResolved };
  } catch {
    return { safe: false, resolved: '' };
  }
}

function parseBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
      return resolve({});
    }
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

module.exports = { securityHeaders, rateLimiter, validateContentLength, sanitizePath, parseBody };
