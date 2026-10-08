const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deviceIdentity } = require('../middleware/deviceIdentity');
const { app } = require('../app');
const Article = require('../models/Article');

function restoreEnvironmentAfter(t) {
  const previous = process.env.NODE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
}

function identify(cookie) {
  const req = { headers: { cookie } };
  const cookies = [];
  let nextCalls = 0;
  deviceIdentity(req, { cookie: (...args) => cookies.push(args) }, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.match(req.deviceId, /^[a-f0-9]{64}$/);
  return { id: req.deviceId, cookies };
}

test('missing cookies create distinct 32-byte device identities', () => {
  const first = identify();
  const second = identify();
  assert.notEqual(first.id, second.id);
  assert.equal(first.cookies.length, 1);
  assert.equal(first.cookies[0][0], 'wd_device');
  assert.equal(first.cookies[0][1], first.id);
});

test('valid device cookie is reused among other cookies without renewal', () => {
  const id = '0123456789abcdef'.repeat(4);
  const result = identify(`wd_session=${'b'.repeat(64)}; wd_device=${id}; preference=dark`);
  assert.equal(result.id, id);
  assert.deepEqual(result.cookies, []);
});

test('malformed and incorrectly named cookies receive a replacement', () => {
  for (const cookie of [
    '', 'wd_device=', 'wd_device=undefined', 'wd_device=%ZZ',
    `wd_device=${'a'.repeat(63)}`, `wd_device=${'a'.repeat(65)}`,
    `wd_device=${'A'.repeat(64)}`, `wd_device=${'g'.repeat(64)}`,
    `wd_device="${'a'.repeat(64)}"`, `wd_device=%61${'a'.repeat(63)}`,
    `other_wd_device=${'a'.repeat(64)}`, `WD_DEVICE=${'a'.repeat(64)}`
  ]) {
    const result = identify(cookie);
    assert.equal(result.cookies.length, 1, cookie);
    assert.equal(result.cookies[0][1], result.id);
  }
});

test('cookie attributes persist for one year and are Secure only in production', t => {
  restoreEnvironmentAfter(t);
  for (const environment of ['test', 'development', 'production']) {
    process.env.NODE_ENV = environment;
    assert.deepEqual(identify().cookies[0][2], {
      httpOnly: true, sameSite: 'lax', path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000, secure: environment === 'production'
    });
  }
});

test('application mounts device identity before homepage, article, and comment handlers', async t => {
  restoreEnvironmentAfter(t);
  process.env.NODE_ENV = 'production';
  t.mock.method(Article, 'find', () => ({
    select() { return this; }, sort() { return this; }, limit() { return this; },
    populate() { return this; }, async lean() { return []; }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, method, status] of [['/', 'GET', 200], ['/articles/invalid', 'GET', 404], ['/comments', 'POST', 400]]) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, status);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('wd_device='));
    assert.ok(cookie, path);
    assert.match(cookie, /^wd_device=[a-f0-9]{64};/);
    for (const attribute of ['Max-Age=31536000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      assert.ok(cookie.split('; ').includes(attribute), attribute);
    }
    const expires = cookie.split('; ').find(value => value.startsWith('Expires=')).slice(8);
    assert.ok(Math.abs(Date.parse(expires) - Date.now() - 31536000000) < 5000);
    const reused = await fetch(base + path, { method, headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(reused.headers.getSetCookie().some(value => value.startsWith('wd_device=')), false);
  }
});
