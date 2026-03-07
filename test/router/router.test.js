'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createRouter } = require('../../control-plane/lib/router');

function mockReq(method, url, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function mockRes() {
  const res = new PassThrough();
  res.statusCode = 200;
  res.headersSent = false;
  const _headers = {};
  res.writeHead = function (code, hdrs) {
    res.statusCode = code;
    if (hdrs) Object.assign(_headers, hdrs);
    res.headersSent = true;
  };
  res.setHeader = function (name, value) { _headers[name] = value; };
  res.getHeader = function (name) { return _headers[name]; };
  res._getHeaders = function () { return _headers; };
  res._body = '';
  const origEnd = res.end.bind(res);
  res.end = function (data) {
    if (data) res._body = data;
    origEnd(data);
  };
  return res;
}

describe('Router', () => {

  describe('route registration and matching', () => {
    it('matches GET routes', async () => {
      const router = createRouter();
      let called = false;
      router.get('/hello', () => { called = true; });
      const matched = await router.handle(mockReq('GET', '/hello'), mockRes());
      assert.equal(matched, true);
      assert.equal(called, true);
    });

    it('matches POST routes', async () => {
      const router = createRouter();
      let called = false;
      router.post('/items', () => { called = true; });
      const matched = await router.handle(mockReq('POST', '/items'), mockRes());
      assert.equal(matched, true);
      assert.equal(called, true);
    });

    it('matches PUT routes', async () => {
      const router = createRouter();
      let called = false;
      router.put('/items/1', () => { called = true; });
      const matched = await router.handle(mockReq('PUT', '/items/1'), mockRes());
      assert.equal(matched, true);
      assert.equal(called, true);
    });

    it('matches DELETE routes', async () => {
      const router = createRouter();
      let called = false;
      router.delete('/items/1', () => { called = true; });
      const matched = await router.handle(mockReq('DELETE', '/items/1'), mockRes());
      assert.equal(matched, true);
      assert.equal(called, true);
    });

    it('does not match wrong method', async () => {
      const router = createRouter();
      router.get('/only-get', () => {});
      const matched = await router.handle(mockReq('POST', '/only-get'), mockRes());
      assert.equal(matched, false);
    });
  });

  describe('route parameter extraction', () => {
    it('extracts a single :id param', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/users/:id', (req) => { captured = req.params; });
      await router.handle(mockReq('GET', '/users/42'), mockRes());
      assert.deepStrictEqual(captured, { id: '42' });
    });

    it('extracts multiple params', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/orgs/:orgId/users/:userId', (req) => { captured = req.params; });
      await router.handle(mockReq('GET', '/orgs/acme/users/99'), mockRes());
      assert.deepStrictEqual(captured, { orgId: 'acme', userId: '99' });
    });

    it('decodes percent-encoded param values', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/files/:name', (req) => { captured = req.params; });
      await router.handle(mockReq('GET', '/files/hello%20world'), mockRes());
      assert.deepStrictEqual(captured, { name: 'hello world' });
    });
  });

  describe('query string parsing', () => {
    it('parses query parameters', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/search', (req) => { captured = req.query; });
      await router.handle(mockReq('GET', '/search?q=test&page=2'), mockRes());
      assert.deepStrictEqual(captured, { q: 'test', page: '2' });
    });

    it('returns empty object when no query string', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/search', (req) => { captured = req.query; });
      await router.handle(mockReq('GET', '/search'), mockRes());
      assert.deepStrictEqual(captured, {});
    });
  });

  describe('cookie parsing', () => {
    it('parses cookies from header', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/me', (req) => { captured = req.cookies; });
      await router.handle(
        mockReq('GET', '/me', { cookie: 'session=abc123; theme=dark' }),
        mockRes()
      );
      assert.deepStrictEqual(captured, { session: 'abc123', theme: 'dark' });
    });

    it('returns empty object when no cookie header', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/me', (req) => { captured = req.cookies; });
      await router.handle(mockReq('GET', '/me'), mockRes());
      assert.deepStrictEqual(captured, {});
    });

    it('handles malformed percent-encoded cookie values like %ZZ without throwing', async () => {
      const router = createRouter();
      let captured = null;
      router.get('/me', (req) => { captured = req.cookies; });
      await router.handle(
        mockReq('GET', '/me', { cookie: 'bad=%ZZ; good=ok' }),
        mockRes()
      );
      assert.equal(captured.bad, '%ZZ');
      assert.equal(captured.good, 'ok');
    });
  });

  describe('404 handling', () => {
    it('returns false when no route matches', async () => {
      const router = createRouter();
      router.get('/existing', () => {});
      const matched = await router.handle(mockReq('GET', '/nonexistent'), mockRes());
      assert.equal(matched, false);
    });

    it('returns false for empty router', async () => {
      const router = createRouter();
      const matched = await router.handle(mockReq('GET', '/anything'), mockRes());
      assert.equal(matched, false);
    });
  });

  describe('res.json()', () => {
    it('sets correct status code, content-type, and body', async () => {
      const router = createRouter();
      router.get('/data', (_req, res) => {
        res.json(200, { ok: true });
      });
      const res = mockRes();
      await router.handle(mockReq('GET', '/data'), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res._getHeaders()['Content-Type'], 'application/json');
      assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
    });

    it('sets Content-Length header', async () => {
      const router = createRouter();
      const payload = { message: 'hello' };
      router.get('/data', (_req, res) => { res.json(201, payload); });
      const res = mockRes();
      await router.handle(mockReq('GET', '/data'), res);
      const expected = Buffer.byteLength(JSON.stringify(payload));
      assert.equal(res._getHeaders()['Content-Length'], expected);
    });
  });

  describe('res.error()', () => {
    it('returns error format with success false', async () => {
      const router = createRouter();
      router.get('/fail', (_req, res) => { res.error(400, 'Bad input'); });
      const res = mockRes();
      await router.handle(mockReq('GET', '/fail'), res);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res._body);
      assert.equal(body.success, false);
      assert.equal(body.error, 'Bad input');
    });
  });

  describe('res.setCookie()', () => {
    it('sets a proper Set-Cookie header with HttpOnly by default', async () => {
      const router = createRouter();
      router.get('/login', (_req, res) => {
        res.setCookie('token', 'abc', { path: '/', secure: true, sameSite: 'Strict' });
        res.json(200, { ok: true });
      });
      const res = mockRes();
      await router.handle(mockReq('GET', '/login'), res);
      const cookies = res._getHeaders()['Set-Cookie'];
      assert.ok(Array.isArray(cookies));
      const cookie = cookies[cookies.length - 1];
      assert.ok(cookie.includes('token=abc'));
      assert.ok(cookie.includes('HttpOnly'));
      assert.ok(cookie.includes('Secure'));
      assert.ok(cookie.includes('SameSite=Strict'));
      assert.ok(cookie.includes('Path=/'));
    });

    it('sets Max-Age when provided', async () => {
      const router = createRouter();
      router.get('/login', (_req, res) => {
        res.setCookie('sid', 'xyz', { maxAge: 3600 });
        res.json(200, { ok: true });
      });
      const res = mockRes();
      await router.handle(mockReq('GET', '/login'), res);
      const cookies = res._getHeaders()['Set-Cookie'];
      const cookie = cookies[cookies.length - 1];
      assert.ok(cookie.includes('Max-Age=3600'));
    });

    it('encodes cookie value', async () => {
      const router = createRouter();
      router.get('/login', (_req, res) => {
        res.setCookie('data', 'a=b&c', {});
        res.json(200, { ok: true });
      });
      const res = mockRes();
      await router.handle(mockReq('GET', '/login'), res);
      const cookies = res._getHeaders()['Set-Cookie'];
      const cookie = cookies[cookies.length - 1];
      assert.ok(cookie.includes('data=' + encodeURIComponent('a=b&c')));
    });
  });
});
