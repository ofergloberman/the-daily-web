const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const GuestCommentLimit = require('../models/GuestCommentLimit');
const PublicationEvent = require('../models/PublicationEvent');
const maintenance = require('../models/userMaintenance');
const { hashToken } = require('../middleware/auth');
const uri = process.env.PERSISTENCE_TEST_MONGODB_URI;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('authentication and guest comments survive separate Node process restarts', {
  skip: !uri && 'Set PERSISTENCE_TEST_MONGODB_URI to a fresh disposable replica-set database.', timeout: 180000
}, async t => {
  assert.match(new URL(uri).pathname.slice(1), /^the_daily_web_persistence_test_[a-f0-9]+$/);
  let child;
  let disposable = false;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  t.after(async () => {
    await stop();
    try { if (disposable) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  });
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false });
  assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), [], 'Use a fresh empty test database.');
  disposable = true;
  for (const Model of [User, Session, Article, Comment, GuestCommentLimit, PublicationEvent]) {
    await Model.createCollection();
    await Model.createIndexes();
  }
  const reporter = await maintenance.createUser({ username: 'restart-reporter', displayName: 'Reporter', role: 'reporter' }, 'temporary-password');
  const editor = await maintenance.createUser({ username: 'restart-editor', displayName: 'Editor', role: 'editor' }, 'temporary-password');
  const articles = await Article.insertMany([1, 2].map(n => ({ author: reporter.id, status: 'published', published: { title: `Restart ${n}` } })));
  const portServer = net.createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(process.execPath, ['app.js'], { cwd: path.join(__dirname, '..'), windowsHide: true,
      env: { ...process.env, MONGODB_URI: uri, PORT: String(port), APP_ORIGIN: base, NODE_ENV: 'test' }, stdio: 'ignore' });
    let spawnError;
    child.once('error', error => { spawnError = error.code; });
    for (let i = 0; i < 150; i++) {
      if (spawnError || child.exitCode !== null) throw new Error(`Server startup failed (${spawnError || child.exitCode}).`);
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return child.pid; } catch {}
      await delay(100);
    }
    throw new Error('Server readiness timed out.');
  }
  function request(route, cookie = '', body, method = body ? 'POST' : 'GET') {
    return fetch(`${base}${route}`, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function login(username) {
    const response = await request('/auth/login', '', { username, password: 'temporary-password' });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('wd_session='))?.split(';')[0];
    assert.match(cookie, /^wd_session=[a-f0-9]{64}$/);
    return cookie;
  }
  const device = () => `wd_device=${randomBytes(32).toString('hex')}`;
  const post = (cookie, article = articles[0]) => request('/comments', cookie, { articleId: String(article._id), displayName: 'Restart guest', body: 'Persistent comment' });
  const originalPid = await start();
  const reporterCookie = await login('restart-reporter');
  const guest = device();
  const first = await post(guest);
  assert.equal(first.status, 201);
  const commentId = (await first.json()).comment.id;
  assert.equal((await post(guest, articles[1])).status, 201);
  assert.equal((await post(guest)).status, 201);
  await stop();
  const restartedPid = await start();
  assert.notEqual(originalPid, restartedPid);
  t.diagnostic(`Stopped Node PID ${originalPid}; restarted with PID ${restartedPid}.`);

  await t.test('original login cookie works after process restart', async () => {
    const response = await request('/auth/me', reporterCookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, reporter.id);
  });
  await t.test('comments persist and guest quota survives restart across articles', async () => {
    assert.equal((await request(`/comments/${commentId}`)).status, 200);
    assert.ok(await Comment.findById(commentId));
    const response = await post(guest, articles[1]);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, 'COMMENT_RATE_LIMIT');
    assert.ok(Number(response.headers.get('retry-after')) > 0);
  });
  await t.test('different device has an independent quota', async () => {
    const second = device();
    for (let i = 0; i < 3; i++) assert.equal((await post(second, articles[i % 2])).status, 201);
    assert.equal((await post(second)).status, 429);
  });
  await t.test('ten simultaneous cross-article requests save exactly three comments', async () => {
    const concurrent = device();
    const before = await Comment.countDocuments();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(concurrent, articles[i % 2])));
    assert.equal(results.filter(r => r.status === 201).length, 3);
    assert.equal(results.filter(r => r.status === 429).length, 7);
    assert.equal(await Comment.countDocuments(), before + 3);
  });
  await t.test('expired session is rejected while database record still exists', async () => {
    // Disable TTL cleanup only in this disposable database to prove expiry is checked by authentication.
    await Session.collection.dropIndex('expiresAt_1');
    const token = randomBytes(32).toString('hex');
    const expired = await Session.create({ tokenHash: hashToken(token), user: reporter.id, expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await request('/auth/me', `wd_session=${token}`)).status, 401);
    assert.ok(await Session.findById(expired._id));
  });
  await t.test('logout deletes the session and cookie replay fails', async () => {
    const cookie = await login('restart-reporter');
    const response = await request('/auth/logout', cookie, {}, 'POST');
    assert.equal(response.status, 204);
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith('wd_session=;')));
    assert.equal(await Session.countDocuments({ tokenHash: hashToken(cookie.split('=')[1]) }), 0);
    assert.equal((await request('/auth/me', cookie)).status, 401);
  });
  await t.test('password reset revokes every original session', async () => {
    const one = await login('restart-reporter');
    const two = await login('restart-reporter');
    await stop(); // Maintenance contract requires stopping application writers.
    await maintenance.resetPassword({ id: reporter.id }, 'new-temporary-password');
    await start();
    for (const cookie of [one, two, reporterCookie]) assert.equal((await request('/auth/me', cookie)).status, 401);
    assert.equal((await request('/auth/login', '', { username: 'restart-reporter', password: 'temporary-password' })).status, 401);
    assert.equal((await request('/auth/login', '', { username: 'restart-reporter', password: 'new-temporary-password' })).status, 200);
  });
  await t.test('editor demotion revokes old privileges; fresh login uses reporter role', async () => {
    const cookie = await login('restart-editor');
    assert.equal((await request('/editor', cookie)).status, 200);
    await stop();
    await maintenance.updateUser({ id: editor.id }, { role: 'reporter' });
    await start();
    assert.equal((await request('/editor', cookie)).status, 401);
    const fresh = await login('restart-editor');
    assert.equal((await request('/editor', fresh)).status, 403);
    assert.equal((await (await request('/auth/me', fresh)).json()).user.role, 'reporter');
  });
});
