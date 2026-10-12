const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const { app } = require('../app');
const { verifyTransactions } = require('../config/transactions');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const PublicationEvent = require('../models/PublicationEvent');
const { hashToken } = require('../middleware/auth');
const ops = require('../models/userMaintenance');
const uri = process.env.USERS_TEST_MONGODB_URI;

test('real MongoDB account lifecycle, revocation, blockers and rollback', { skip: !uri && 'Set USERS_TEST_MONGODB_URI to a dedicated replica-set test database.' }, async t => {
  // Check before connecting: Mongoose model initialization may create collections.
  const name = new URL(uri).pathname.slice(1);
  assert.match(name, /^the_daily_web_users_test_[a-f0-9]+$/);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false });
  let disposable = false;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { if (disposable) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  });
  assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), [], 'Use a fresh empty database.');
  disposable = true;
  await verifyTransactions(mongoose.connection);
  for (const Model of [User, Session, Article, Comment, PublicationEvent]) { await Model.createCollection(); await Model.createIndexes(); }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = randomBytes(32).toString('hex');
  const session = async id => Session.create({ user: id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000) });
  const me = () => fetch(`${base}/auth/me`, { headers: { Cookie: `wd_session=${token}` } });
  const selector = { username: 'writer' };
  const reporter = await ops.createUser({ username: ' WRITER ', displayName: ' Writer ', role: 'reporter' }, 'old-password');
  assert.equal(reporter.username, 'writer');
  assert.deepEqual(Object.keys(reporter).sort(), ['id', 'username', 'displayName', 'role', 'createdAt', 'updatedAt'].sort());
  assert.equal((await ops.readUser({ id: reporter.id })).username, 'writer');
  assert.equal((await ops.readUser({ username: ' WRITER ' })).id, reporter.id);
  await assert.rejects(ops.createUser({ username: 'writer', displayName: 'Duplicate', role: 'editor' }, 'test-password'), { code: 'DUPLICATE_USERNAME' });
  const editor = await ops.createUser({ username: 'editor', displayName: 'Editor', role: 'editor' }, 'editor-password');
  assert.equal((await ops.listUsers({ limit: 1 })).length, 1);
  assert.equal((await ops.listUsers({ search: 'WR' }))[0].id, reporter.id);
  assert.equal((await ops.listUsers({ search: '.*' })).length, 0);
  assert.equal((await ops.listUsers({ offset: 1 }))[0].id, reporter.id);
  await assert.rejects(ops.readUser({ username: 'absent' }), { code: 'USER_NOT_FOUND' });
  for (const operation of [() => ops.updateUser({ username: 'absent' }, { displayName: 'New' }),
    () => ops.resetPassword({ username: 'absent' }, 'new-password'), () => ops.deleteUser({ username: 'absent' })]) {
    await assert.rejects(operation(), { code: 'USER_NOT_FOUND' });
  }
  await session(reporter.id);
  assert.equal((await me()).status, 200);
  await ops.updateUser(selector, { displayName: 'New Name', username: 'renamed' });
  selector.username = 'renamed';
  assert.equal((await (await me()).json()).user.displayName, 'New Name');
  await assert.rejects(ops.updateUser(selector, { username: 'editor' }), { code: 'DUPLICATE_USERNAME' });
  assert.equal((await ops.readUser(selector)).username, 'renamed');
  await ops.resetPassword(selector, 'new-password');
  assert.equal((await me()).status, 401);
  const saved = await User.findById(reporter.id).select('+passwordHash');
  assert.equal(await saved.verifyPassword('old-password'), false);
  assert.equal(await saved.verifyPassword('new-password'), true);
  await session(reporter.id);
  await ops.updateUser(selector, { role: 'editor' });
  assert.equal((await me()).status, 401);
  await session(reporter.id);
  await ops.updateUser(selector, { role: 'editor' });
  assert.equal((await me()).status, 200, 'Unchanged role preserves sessions.');

  const article = await Article.create({ author: reporter.id });
  const comment = await Comment.create({ article: article._id, author: reporter.id, displayName: 'Historical Name', body: 'Comment' });
  const event = await PublicationEvent.create({ article: article._id, editor: reporter.id, kind: 'initial', publishedAt: new Date() });
  await assert.rejects(ops.deleteUser(selector), error => error.code === 'USER_REFERENCED' && /articles, comments, publication events/.test(error.message));
  assert.equal((await me()).status, 200, 'Rejected deletion preserves sessions.');
  await Article.updateOne({ _id: article._id }, { author: editor.id });
  await assert.rejects(ops.deleteUser(selector), /comments, publication events/);
  await Comment.updateOne({ _id: comment._id }, { author: null });
  await assert.rejects(ops.deleteUser(selector), /publication events/);
  await PublicationEvent.updateOne({ _id: event._id }, { editor: editor.id });
  // Failure after the account write must roll back both deletion and password/role edits.
  const failure = t.mock.method(Session, 'deleteMany', () => { throw new Error('private database details'); });
  for (const operation of [() => ops.resetPassword(selector, 'rollback-password'),
    () => ops.updateUser(selector, { role: 'reporter' }), () => ops.deleteUser(selector)]) {
    await assert.rejects(operation(), { code: 'DATABASE_FAILURE' });
    assert.equal((await ops.readUser(selector)).role, 'editor');
    assert.equal((await me()).status, 200);
  }
  failure.mock.restore();
  assert.equal(await (await User.findById(reporter.id).select('+passwordHash')).verifyPassword('new-password'), true);
  await ops.deleteUser(selector);
  assert.equal((await me()).status, 401);
  assert.equal(await User.findById(reporter.id), null);
  assert.equal((await Comment.findById(comment._id)).displayName, 'Historical Name');
  assert.equal(await PublicationEvent.countDocuments(), 1);
  assert.doesNotMatch(JSON.stringify(await ops.listUsers()), /passwordHash|scrypt:|tokenHash/);
});
