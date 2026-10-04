const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const { hashToken, readSessionToken } = require('../middleware/auth');

function getCookie(response, name) {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith(`${name}=`));
}

async function listen() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('passwords use salted, one-way hashes and never appear in JSON', async () => {
  const first = new User({ username: 'reporter', displayName: 'Reporter', role: 'reporter' });
  const second = new User({ username: 'editor', displayName: 'Editor', role: 'editor' });
  await first.setPassword('correct-password');
  await second.setPassword('correct-password');
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(first.passwordHash.includes('correct-password'), false);
  assert.equal(await first.verifyPassword('correct-password'), true);
  assert.equal(await first.verifyPassword('wrong-password'), false);
  assert.equal(first.toJSON().passwordHash, undefined);
  await assert.rejects(first.setPassword('short'));
  first.passwordHash = 'plaintext';
  await assert.rejects(first.validate(), error => Boolean(error.errors.passwordHash));
});

test('login, role checks, restart continuity, and logout', async t => {
  const reporter = new User({ _id: new mongoose.Types.ObjectId(), username: 'reporter', displayName: 'Reporter', role: 'reporter' });
  const editor = new User({ _id: new mongoose.Types.ObjectId(), username: 'editor', displayName: 'Editor', role: 'editor' });
  await reporter.setPassword('correct-password');
  await editor.setPassword('editor-password');
  const sessions = new Map();
  t.mock.method(User, 'findOne', ({ username }) => ({ select: async () => ({ reporter, editor })[username] || null }));
  t.mock.method(Session, 'create', async data => { sessions.set(data.tokenHash, data); return data; });
  t.mock.method(Session, 'findOne', ({ tokenHash, expiresAt }) => ({
    populate: async () => {
      const saved = sessions.get(tokenHash);
      return saved && saved.expiresAt > expiresAt.$gt ? { user: saved.user.equals(reporter._id) ? reporter : editor } : null;
    }
  }));
  t.mock.method(Session, 'deleteOne', async ({ tokenHash }) => { sessions.delete(tokenHash); });
  t.mock.method(Article, 'find', () => ({
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
    async lean() { return []; }
  }));

  let running = await listen();
  t.after(async () => { if (running.server.listening) await new Promise(resolve => running.server.close(resolve)); });
  const post = (url, body, cookie) => fetch(running.base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
  });

  assert.equal((await fetch(running.base + '/auth/me')).status, 401);
  assert.equal((await fetch(running.base + '/reporter')).status, 401);
  assert.equal((await post('/auth/login', { username: 'reporter', password: 'wrong-password' })).status, 401);
  assert.equal((await post('/auth/login', { username: 'reporter', password: '' })).status, 400);
  assert.equal(sessions.size, 0);

  const login = await post('/auth/login', { username: ' REPORTER ', password: 'correct-password', role: 'editor' });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, 'reporter');
  const cookie = getCookie(login, 'wd_session').split(';')[0];
  assert.match(getCookie(login, 'wd_device'), /^wd_device=[a-f0-9]{64};/);
  const token = readSessionToken(cookie);
  assert.ok(token);
  assert.equal(sessions.has(hashToken(token)), true);
  assert.equal(sessions.has(token), false);
  assert.equal((await fetch(running.base + '/auth/me', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(running.base + '/reporter', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(running.base + '/editor', { headers: { Cookie: cookie } })).status, 403);

  await new Promise(resolve => running.server.close(resolve));
  running = await listen();
  assert.equal((await fetch(running.base + '/auth/me', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(running.base + '/auth/me', { headers: { Cookie: 'wd_session=invalid' } })).status, 401);
  const logout = await fetch(running.base + '/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.equal(sessions.size, 0);
  assert.equal((await fetch(running.base + '/auth/me', { headers: { Cookie: cookie } })).status, 401);

  const editorLogin = await post('/auth/login', { username: 'editor', password: 'editor-password' });
  assert.equal(editorLogin.status, 200);
  assert.equal((await editorLogin.json()).redirectTo, '/editor');
  const editorCookie = getCookie(editorLogin, 'wd_session').split(';')[0];
  assert.equal((await fetch(running.base + '/editor', { headers: { Cookie: editorCookie } })).status, 200);
  assert.equal((await fetch(running.base + '/reporter', { headers: { Cookie: editorCookie } })).status, 403);

  // An existing guest identity survives session creation, rotation, and deletion.
  const guest = await fetch(running.base + '/auth');
  const deviceCookie = getCookie(guest, 'wd_device').split(';')[0];
  const guestLogin = await post('/auth/login', { username: 'reporter', password: 'correct-password' }, deviceCookie);
  assert.equal(guestLogin.status, 200);
  assert.equal(getCookie(guestLogin, 'wd_device'), undefined);
  const guestSession = getCookie(guestLogin, 'wd_session').split(';')[0];
  const rotatedLogin = await post('/auth/login', { username: 'reporter', password: 'correct-password' }, `${deviceCookie}; ${guestSession}`);
  assert.equal(rotatedLogin.status, 200);
  assert.equal(getCookie(rotatedLogin, 'wd_device'), undefined);
  const rotatedSession = getCookie(rotatedLogin, 'wd_session').split(';')[0];
  const guestLogout = await post('/auth/logout', {}, `${deviceCookie}; ${rotatedSession}`);
  assert.equal(guestLogout.status, 204);
  assert.match(getCookie(guestLogout, 'wd_session'), /^wd_session=;/);
  assert.equal(getCookie(guestLogout, 'wd_device'), undefined);
  const afterLogout = await fetch(running.base + '/auth', { headers: { Cookie: deviceCookie } });
  assert.equal(afterLogout.status, 200);
  assert.equal(getCookie(afterLogout, 'wd_device'), undefined);
});
