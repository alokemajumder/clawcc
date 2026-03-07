'use strict';

const { URL } = require('url');

function createRouter() {
  const routes = [];

  function addRoute(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp('^' + regexStr + '$'), paramNames, handler });
  }

  function parseQuery(search) {
    const params = {};
    if (!search) return params;
    const sp = new URLSearchParams(search);
    for (const [k, v] of sp) params[k] = v;
    return params;
  }

  function safeDecode(val) {
    try { return decodeURIComponent(val); } catch { return val; }
  }

  function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    header.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        cookies[key] = safeDecode(val);
      }
    });
    return cookies;
  }

  const router = {
    get(path, handler) { addRoute('GET', path, handler); },
    post(path, handler) { addRoute('POST', path, handler); },
    put(path, handler) { addRoute('PUT', path, handler); },
    delete(path, handler) { addRoute('DELETE', path, handler); },

    async handle(req, res) {
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = parsed.pathname;
      const method = req.method;

      req.query = parseQuery(parsed.search);
      req.cookies = parseCookies(req.headers.cookie);
      req.params = {};

      res.json = function(statusCode, data) {
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
      };

      res.error = function(statusCode, message) {
        res.json(statusCode, { success: false, error: message });
      };

      res.setCookie = function(name, value, options = {}) {
        const parts = [name + '=' + encodeURIComponent(value)];
        if (options.httpOnly !== false) parts.push('HttpOnly');
        if (options.secure) parts.push('Secure');
        if (options.sameSite) parts.push('SameSite=' + options.sameSite);
        if (options.path) parts.push('Path=' + options.path);
        if (options.maxAge != null) parts.push('Max-Age=' + options.maxAge);
        if (options.expires) parts.push('Expires=' + options.expires.toUTCString());
        const existing = res.getHeader('Set-Cookie') || [];
        const arr = Array.isArray(existing) ? existing : [existing];
        arr.push(parts.join('; '));
        res.setHeader('Set-Cookie', arr);
      };

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = pathname.match(route.regex);
        if (match) {
          route.paramNames.forEach((name, i) => {
            req.params[name] = safeDecode(match[i + 1]);
          });
          try {
            await route.handler(req, res);
          } catch (err) {
            console.error('Route error:', err);
            if (!res.headersSent) {
              res.error(500, 'Internal server error');
            }
          }
          return true;
        }
      }
      return false;
    }
  };

  return router;
}

module.exports = { createRouter };
