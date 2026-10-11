const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const { app } = require('../app');
const { verifyTransactions } = require('../config/transactions');
const { hashToken } = require('../middleware/auth');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const PublicationEvent = require('../models/PublicationEvent');
const users = require('../models/userMaintenance');

const uri = process.env.USERS_TEST_MONGODB_URI;
test('real MongoDB account lifecycle, atomic revocation, reference checks and CSRF', {
  skip: !uri && 'Set USERS_TEST_MONGODB_URI to a dedicated transaction-capable test database.'
}, async t => {
  // Validate BEFORE connecting, creating indexes, or dropping anything.
  const database = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)(?:\?|$)/)?.[1];
  assert.match(database || '', /^the_daily_web_users_test_[a-f0-9]+$/);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await verifyTransactions(mongoose.connection);
  await Promise.all([User.init(), Session.init(), Article.init(), Comment.init(), PublicationEvent.init()]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const make = (username, role = 'reporter') => users.createUser({ username, displayName: username, role }, 'initial-password');
  const account = await make(' Writer ');
  const other = await make('writer.two');
  const editor = await make('editor', 'editor');
  assert.equal(account.username, 'writer');
  assert.deepEqual(await users.readUser({ id: account.id }), await users.readUser({ username: ' WRITER ' }));
  await assert.rejects(make('WRITER'), { code: 'DUPLICATE_USERNAME' });
  await assert.rejects(users.updateUser({ id: account.id }, { username: 'EDITOR' }), { code: 'DUPLICATE_USERNAME' });
  await assert.rejects(users.readUser({ id: new mongoose.Types.ObjectId().toString() }), { code: 'NOT_FOUND' });
  const page = await users.listUsers({ search: 'WRITER', limit: 1 });
  assert.equal(page.users.length, 1);
  assert.equal(page.nextAfter, 'writer');
  const next = await users.listUsers({ search: 'writer', after: page.nextAfter, limit: 1 });
  assert.equal(next.users[0].id, other.id);
  assert.equal(next.nextAfter, null);
  assert.equal((await users.listUsers({ search: 'writer.' })).users.length, 1);
  assert.equal((await users.listUsers({ search: '.*' })).users.length, 0);
  assert.doesNotMatch(JSON.stringify([account, page, next]), /password|scrypt:|token|authVersion/i);

  async function login(name, password, form = false, origin = base) {
    return fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual',
      headers: { Origin: origin, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams({ username: name, password }) : JSON.stringify({ username: name, password }) });
  }
  const cookie = response => response.headers.getSetCookie().find(value => value.startsWith('wd_session=')).split(';')[0];
  const me = value => fetch(`${base}/auth/me`, { headers: { Cookie: value } });
  let response = await login('writer', 'initial-password', true);
  assert.equal(response.status, 303);
  const oldCookie = cookie(response);
  assert.equal((await me(oldCookie)).status, 200);
  await users.updateUser({ id: account.id }, { username: 'renamed', displayName: 'New Name' });
  assert.equal((await (await me(oldCookie)).json()).user.displayName, 'New Name');
  await users.resetPassword({ id: account.id }, 'replacement-password');
  assert.equal(await Session.countDocuments({ user: account.id }), 0);
  assert.equal((await me(oldCookie)).status, 401);
  assert.equal((await login('renamed', 'initial-password')).status, 401);
  response = await login('renamed', 'replacement-password');
  assert.equal(response.status, 200);
  const resetCookie = cookie(response);
  await users.updateUser({ id: account.id }, { role: 'editor' });
  assert.equal((await me(resetCookie)).status, 401);
  assert.equal(await Session.countDocuments({ user: account.id }), 0);
  // Simulate a login that read the old user before reset/role change but inserted later.
  const stale = randomBytes(32).toString('hex');
  await Session.create({ user: account.id, tokenHash: hashToken(stale), authVersion: 0, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await me(`wd_session=${stale}`)).status, 401);

  const beforeReset = await User.findById(account.id).select('+passwordHash');
  const failure = t.mock.method(Session, 'deleteMany', async () => { throw new Error('forced failure'); });
  await assert.rejects(users.resetPassword({ id: account.id }, 'rolled-back-password'), { code: 'DATABASE_FAILURE' });
  failure.mock.restore();
  const afterReset = await User.findById(account.id).select('+passwordHash');
  assert.equal(afterReset.passwordHash, beforeReset.passwordHash);
  assert.equal(afterReset.authVersion, beforeReset.authVersion);

  // Check each reference independently, retaining both content and sessions.
  const article = await Article.create({ author: other.id, published: { title: 'Approved' }, status: 'published' });
  const fixtures = [
    [Article, { author: account.id }],
    [Comment, { article: article.id, author: account.id, displayName: 'Old Name', body: 'History' }],
    [PublicationEvent, { article: article.id, editor: account.id, kind: 'initial', publishedAt: new Date() }]
  ];
  for (const [Model, data] of fixtures) {
    const ref = await Model.create(data);
    const sessions = await Session.countDocuments({ user: account.id });
    await assert.rejects(users.deleteUser({ id: account.id }, { offline: true }), { code: 'USER_REFERENCED' });
    assert.ok(await User.exists({ _id: account.id }));
    assert.ok(await Model.exists({ _id: ref.id }));
    assert.equal(await Session.countDocuments({ user: account.id }), sessions);
    await Model.deleteOne({ _id: ref.id });
  }

  const reporterCookie = cookie(await login('writer.two', 'initial-password'));
  const editorCookie = cookie(await login('editor', 'initial-password'));
  const snapshot = async () => Promise.all([User.countDocuments(), Session.countDocuments(), Article.countDocuments(), Comment.countDocuments(), PublicationEvent.countDocuments()]);
  const beforeForgery = await snapshot();
  for (const [path, method, payload, auth] of [
    ['/auth/login', 'POST', { username: 'editor', password: 'initial-password' }, ''],
    ['/auth/logout', 'POST', {}, editorCookie],
    ['/reporter/articles', 'POST', {}, reporterCookie],
    ['/comments', 'POST', { articleId: article.id, body: 'Forged' }, reporterCookie]
  ]) {
    const forged = await fetch(`${base}${path}`, { method, headers: { Origin: 'https://evil.example', Cookie: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(forged.status, 403);
  }
  assert.deepEqual(await snapshot(), beforeForgery);
  const post = await fetch(`${base}/comments`, { method: 'POST', headers: { Origin: base, Cookie: reporterCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ articleId: article.id, body: 'Legitimate' }) });
  assert.equal(post.status, 201);
  const commentId = (await post.json()).comment.id;
  const editorMutation = (origin, body) => fetch(`${base}/comments/${commentId}`, { method: 'PATCH', headers: { Origin: origin, Cookie: editorCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  assert.equal((await editorMutation('https://evil.example', 'Forged')).status, 403);
  assert.equal((await Comment.findById(commentId)).body, 'Legitimate');
  assert.equal((await editorMutation(base, 'Reviewed')).status, 200);
  assert.equal((await Comment.findById(commentId)).body, 'Reviewed');
  assert.equal((await fetch(`${base}/comments?articleId=${article.id}`)).status, 200);
  const deletionCookie = cookie(await login('renamed', 'replacement-password'));
  const result = await users.deleteUser({ id: account.id }, { offline: true });
  assert.equal(result.deleted.id, account.id);
  assert.equal(await User.exists({ _id: account.id }), null);
  assert.equal(await Session.countDocuments({ user: account.id }), 0);
  assert.equal((await me(deletionCookie)).status, 401);
  await assert.rejects(users.deleteUser({ id: account.id }, { offline: true }), { code: 'NOT_FOUND' });
});
