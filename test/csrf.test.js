const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../app');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const { applicationOrigin, csrfProtection } = require('../middleware/csrf');

function environment(t) {
  const saved = { APP_ORIGIN: process.env.APP_ORIGIN, NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT };
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.NODE_ENV = 'test';
  process.env.APP_ORIGIN = 'https://news.example.test';
}
function check(headers, method = 'POST') {
  let status;
  let body;
  let passed = false;
  csrfProtection({ method, headers }, { status(value) { status = value; return this; }, json(value) { body = value; } }, () => { passed = true; });
  return { status, body, passed };
}

test('Origin contract accepts forms/AJAX, falls back to Referer only when Origin is absent', t => {
  environment(t);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(check({ origin: process.env.APP_ORIGIN }, method).passed, true);
    assert.equal(check({ referer: `${process.env.APP_ORIGIN}/article?from=home` }, method).passed, true);
  }
  for (const headers of [{}, { origin: 'null' }, { origin: '' }, { origin: 'bad' },
    { origin: 'https://evil.test' }, { origin: 'http://news.example.test' }, { origin: 'https://news.example.test:444' },
    { origin: 'https://news.example.test.evil.test' }, { origin: 'https://news.example.test/' },
    { origin: 'https://news.example.test https://evil.test' }, { origin: 'https://evil.test', referer: process.env.APP_ORIGIN },
    { origin: 'null', referer: process.env.APP_ORIGIN }, { origin: ['https://news.example.test'] },
    { referer: 'https://evil.test/article' }, { referer: '/relative' }, { referer: 'https://user:secret@news.example.test/' },
    { origin: process.env.APP_ORIGIN, 'sec-fetch-site': 'cross-site' },
    { origin: 'https://evil.test', host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' }]) {
    assert.equal(check(headers).status, 403, JSON.stringify(headers));
    assert.equal(check(headers).body.error, 'CSRF_REJECTED');
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(check({}, method).passed, true);
});

test('origin configuration is explicit in production and fails closed when invalid', t => {
  environment(t);
  delete process.env.APP_ORIGIN;
  process.env.PORT = '4000';
  assert.equal(applicationOrigin(), 'http://localhost:4000');
  process.env.NODE_ENV = 'production';
  assert.throws(applicationOrigin, /required/);
  for (const value of ['http://news.example.test', 'https://user:secret@news.example.test', 'https://news.example.test/path', 'null', 'https://news.example.test?q=1', 'https://news.example.test/#fragment']) {
    process.env.APP_ORIGIN = value;
    assert.throws(applicationOrigin);
    assert.equal(check({ origin: 'https://news.example.test' }).status, 503);
  }
  process.env.APP_ORIGIN = 'https://news.example.test';
  assert.equal(applicationOrigin(), process.env.APP_ORIGIN);
});

test('every mutation route rejects before model access; public reads and legitimate forms remain usable', async t => {
  environment(t);
  for (const [Model, methods] of [[User, ['findOne']], [Session, ['findOne', 'create', 'deleteOne']],
    [Article, ['create', 'findOne', 'findOneAndUpdate']], [Comment, ['create', 'findOneAndUpdate', 'deleteOne']]]) {
    for (const method of methods) t.mock.method(Model, method, () => { assert.fail('Rejected request reached database'); });
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const id = 'a'.repeat(24);
  const routes = [['POST', '/auth/login'], ['POST', '/auth/logout'], ['POST', '/comments'],
    ['PATCH', `/comments/${id}`], ['DELETE', `/comments/${id}`], ['POST', '/reporter/articles'],
    ['PATCH', `/reporter/articles/${id}/draft`], ['POST', `/reporter/articles/${id}/submit`],
    ['POST', '/articles'], ['PATCH', `/articles/${id}`], ['DELETE', `/articles/${id}`],
    ['POST', `/editor/articles/${id}/approve`]];
  for (const [method, path] of routes) {
    for (const origin of [undefined, 'null', 'https://evil.test']) {
      const response = await fetch(base + path, { method, headers: { Cookie: `wd_session=${'b'.repeat(64)}`,
        ...(origin !== undefined ? { Origin: origin } : {}) } });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).error, 'CSRF_REJECTED');
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  }
  assert.equal((await fetch(base + '/auth')).status, 200);
  const form = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=&password=' });
  assert.equal(form.status, 400);
  assert.match(await form.text(), /Enter a username and password/);
  const ajax = await fetch(base + '/auth/login', { method: 'POST', headers: { Referer: base + '/auth', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(ajax.status, 400);
  assert.equal((await ajax.json()).error, 'INVALID_INPUT');
});
