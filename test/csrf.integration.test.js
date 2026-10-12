const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomBytes } = require('node:crypto');
const { app } = require('../app');
const { verifyTransactions } = require('../config/transactions');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const GuestCommentLimit = require('../models/GuestCommentLimit');
const PublicationEvent = require('../models/PublicationEvent');
const { hashToken } = require('../middleware/auth');
const uri = process.env.CSRF_TEST_MONGODB_URI;

test('CSRF rejection leaves real database unchanged; same-origin forms and AJAX succeed', { skip: !uri && 'Set CSRF_TEST_MONGODB_URI to a dedicated replica-set test database.' }, async t => {
  assert.match(new URL(uri).pathname.slice(1), /^the_daily_web_csrf_test_[a-f0-9]+$/);
  let disposable = false;
  let server;
  const previousOrigin = process.env.APP_ORIGIN;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false });
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { if (disposable) await mongoose.connection.dropDatabase(); }
    finally {
      await mongoose.disconnect();
      if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
    }
  });
  assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), [], 'Use a fresh empty database.');
  disposable = true;
  await verifyTransactions(mongoose.connection);
  const models = [User, Session, Article, Comment, GuestCommentLimit, PublicationEvent];
  for (const Model of models) { await Model.createCollection(); await Model.createIndexes(); }
  async function account(username, role) {
    const user = new User({ username, displayName: username, role });
    await user.setPassword('test-password');
    await user.save();
    const token = randomBytes(32).toString('hex');
    await Session.create({ user: user._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000) });
    return { user, cookie: `wd_session=${token}` };
  }
  const reporter = await account('writer', 'reporter');
  const editor = await account('editor', 'editor');
  const content = { title: 'News', summary: 'Summary', body: 'Story', category: 'World', imageUrl: 'https://example.test/photo.jpg' };
  const article = await Article.create({ author: reporter.user._id, draft: content, published: content, status: 'draft' });
  const comment = await Comment.create({ article: article._id, author: reporter.user._id, displayName: 'Writer', body: 'Original' });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const request = (path, method, body, cookie, origin = base) => fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const snapshot = async () => JSON.stringify(await Promise.all(models.map(Model => Model.find().sort({ _id: 1 }).lean())));
  const before = await snapshot();
  const attempts = [
    ['/auth/login', 'POST', { username: 'writer', password: 'test-password' }, undefined],
    ['/auth/logout', 'POST', {}, reporter.cookie],
    ['/comments', 'POST', { articleId: String(article._id), body: 'Attack', displayName: 'Guest' }, undefined],
    ['/comments', 'POST', { articleId: String(article._id), body: 'Attack' }, reporter.cookie],
    [`/comments/${comment._id}`, 'PATCH', { body: 'Attack' }, editor.cookie],
    [`/comments/${comment._id}`, 'DELETE', undefined, editor.cookie],
    ['/reporter/articles', 'POST', {}, reporter.cookie],
    [`/reporter/articles/${article._id}/draft`, 'PATCH', { ...content, title: 'Attack', baseVersion: 0 }, reporter.cookie],
    [`/reporter/articles/${article._id}/submit`, 'POST', { baseVersion: 0 }, reporter.cookie]
  ];
  for (const [path, method, body, cookie] of attempts) {
    for (const origin of ['https://evil.test', 'null', '']) assert.equal((await request(path, method, body, cookie, origin)).status, 403);
  }
  assert.equal(await snapshot(), before);
  const login = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=writer&password=test-password' });
  assert.equal(login.status, 303);
  const formCookie = login.headers.getSetCookie().find(value => value.startsWith('wd_session=')).split(';')[0];
  const created = await request('/reporter/articles', 'POST', {}, reporter.cookie);
  assert.equal(created.status, 201);
  assert.equal((await request(`/reporter/articles/${article._id}/draft`, 'PATCH', { ...content, title: 'Updated', baseVersion: 0 }, reporter.cookie)).status, 200);
  assert.equal((await request(`/reporter/articles/${article._id}/submit`, 'POST', { baseVersion: 1 }, reporter.cookie)).status, 200);
  assert.equal((await Article.findById(article._id)).published.title, 'News');
  const added = await request('/comments', 'POST', { articleId: String(article._id), body: 'Hello' }, reporter.cookie);
  assert.equal(added.status, 201);
  const fallback = await fetch(base + `/comments/${comment._id}`, { method: 'PATCH', headers: {
    Referer: base + '/editor', Cookie: editor.cookie, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ body: 'Edited' }) });
  assert.equal(fallback.status, 200);
  assert.equal((await Comment.findById(comment._id)).body, 'Edited');
  assert.equal((await request(`/comments/${comment._id}`, 'DELETE', undefined, editor.cookie)).status, 204);
  assert.equal((await request('/auth/logout', 'POST', {}, formCookie)).status, 204);
  assert.equal((await fetch(base + '/auth/me', { headers: { Cookie: formCookie } })).status, 401);
  assert.equal((await fetch(base + '/articles')).status, 200);
});
