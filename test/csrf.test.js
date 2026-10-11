const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { csrfProtection, applicationOrigin } = require('../middleware/csrf');
const { app } = require('../app');
const Session = require('../models/Session');

test('Origin contract accepts forms/AJAX and denies forged requests before any state changes', async t => {
  const serverApp = express();
  let changes = 0;
  serverApp.use(csrfProtection);
  serverApp.all('/mutation', (_req, res) => { changes += 1; res.sendStatus(204); });
  serverApp.get('/read', (_req, res) => res.json({ readable: true }));
  const server = serverApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  for (const headers of [{ Origin: base, 'Content-Type': 'application/json' },
    { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, { Referer: `${base}/auth?next=reporter` }]) {
    assert.equal((await fetch(`${base}/mutation`, { method: 'POST', headers })).status, 204);
  }
  assert.equal(changes, 3);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const headers of [{}, { Origin: 'null', Referer: base }, { Origin: 'https://evil.example', Referer: base },
      { Origin: `${base}.evil.example` }, { Origin: `${base}/path` }, { Origin: `${base}, ${base}` },
      { Referer: 'https://evil.example/form' }, { Referer: 'garbage' }, { Origin: `https://127.0.0.1:${server.address().port}` },
      { Origin: 'http://localhost:3000' }, { Origin: `${base}/` }, { 'X-Forwarded-Host': 'evil.example', Origin: 'https://evil.example' }]) {
      const response = await fetch(`${base}/mutation`, { method, headers });
      assert.equal(response.status, 403, `${method} ${JSON.stringify(headers)}`);
      assert.equal((await response.json()).error, 'CSRF_REJECTED');
    }
  }
  assert.equal(changes, 3);
  assert.equal((await fetch(`${base}/read`, { headers: { Origin: 'https://evil.example' } })).status, 200);
});

test('all application mutation prefixes reject CSRF before session/database access', async t => {
  let accesses = 0;
  t.mock.method(Session, 'findOne', () => { accesses += 1; throw new Error('Must not reach authentication'); });
  process.env.APP_ORIGIN = 'http://localhost:3000';
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [path, method] of [['/auth/login', 'POST'], ['/auth/logout', 'POST'], ['/comments', 'POST'],
    ['/comments/123', 'PATCH'], ['/comments/123', 'DELETE'], ['/reporter/articles', 'POST'],
    ['/reporter/articles/123/draft', 'PATCH'], ['/reporter/articles/123/submit', 'POST'],
    ['/editor/articles/123/approve', 'POST'], ['/editor/articles/123', 'DELETE']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { Origin: 'https://evil.example', Cookie: `wd_session=${'a'.repeat(64)}` }
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'CSRF_REJECTED');
  }
  assert.equal(accesses, 0);
});

test('origin configuration is explicit in production and rejects ambiguous URLs', t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.NODE_ENV = 'production';
  for (const value of ['', 'http://example.com', 'https://example.com/path', 'https://u:p@example.com', 'https://example.com?x=1', 'https://example.com#x']) {
    process.env.APP_ORIGIN = value;
    assert.throws(applicationOrigin, /APP_ORIGIN/);
  }
  process.env.APP_ORIGIN = 'https://news.example.com';
  assert.equal(applicationOrigin(), 'https://news.example.com');
  delete process.env.APP_ORIGIN;
  process.env.NODE_ENV = 'development';
  process.env.PORT = '3456';
  assert.equal(applicationOrigin(), 'http://localhost:3456');
});
