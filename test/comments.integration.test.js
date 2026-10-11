const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const { app } = require('../app');
const { verifyTransactions } = require('../config/transactions');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const GuestCommentLimit = require('../models/GuestCommentLimit');
const User = require('../models/User');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');
const { createGuestComment } = require('../services/comments');

const uri = process.env.COMMENTS_TEST_MONGODB_URI;

test('comments API and atomic limiter against real MongoDB', { skip: !uri && 'Set COMMENTS_TEST_MONGODB_URI to a transaction-capable test database.' }, async t => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const databaseName = mongoose.connection.name;
  assert.match(databaseName, /^the_daily_web_comments_test_[a-f0-9]+$/);
  t.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await verifyTransactions(mongoose.connection);
  await Promise.all([Article.init(), Comment.init(), GuestCommentLimit.init(), User.init(), Session.init()]);

  const reporter = new User({ username: 'comment-reporter', displayName: 'Real Reporter', role: 'reporter' });
  await reporter.setPassword('temporary-test-password');
  await reporter.save();
  const editor = new User({ username: 'comment-editor', displayName: 'Real Editor', role: 'editor' });
  await editor.setPassword('temporary-test-password');
  await editor.save();
  const articles = await Article.insertMany([
    { author: reporter._id, status: 'published', published: { title: 'One' } },
    { author: reporter._id, status: 'published', published: { title: 'Two' } },
    { author: reporter._id, status: 'draft', draft: { title: 'Private' } },
    { author: reporter._id, status: 'pending', published: { title: 'Approved' }, draft: { title: 'Pending revision' } }
  ]);
  const [first, second, privateArticle, revision] = articles;
  const sessionToken = randomBytes(32).toString('hex');
  await Session.create({ tokenHash: hashToken(sessionToken), user: reporter._id, expiresAt: new Date(Date.now() + 600000) });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = deviceId => `wd_device=${deviceId}`;
  const device = () => randomBytes(32).toString('hex');
  async function post(articleId, deviceId, changes = {}, session = '') {
    const response = await fetch(`${base}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${cookie(deviceId)}${session ? `; wd_session=${session}` : ''}` },
      body: JSON.stringify({ articleId: String(articleId), displayName: '  Guest  ', body: '  Hello  ', ...changes })
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }

  const guestDevice = device();
  const created = await post(first._id, guestDevice);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.data.comment).sort(), ['body', 'createdAt', 'displayName', 'id', 'articleId'].sort());
  assert.equal(created.data.comment.displayName, 'Guest');
  assert.equal(created.data.comment.body, 'Hello');
  assert.equal((await Comment.findById(created.data.comment.id)).author, null);
  for (const spoof of [{ author: String(editor._id) }, { role: 'editor' }, { deviceId: device() }]) {
    assert.equal((await post(first._id, device(), spoof)).status, 400);
  }
  assert.equal((await post(revision._id, device(), {})).status, 201);
  assert.equal((await post(privateArticle._id, device(), {})).status, 404);
  assert.equal((await post('bad-id', device(), {})).status, 400);
  assert.equal((await post(new mongoose.Types.ObjectId(), device(), {})).status, 404);

  for (const changes of [
    { displayName: ' ' }, { displayName: 'x'.repeat(101) }, { displayName: 12 },
    { body: ' ' }, { body: 'x'.repeat(2001) }, { body: 12 }
  ]) assert.equal((await post(first._id, device(), changes)).status, 400);
  assert.equal((await post(first._id, device(), { displayName: 'x'.repeat(100), body: 'x'.repeat(2000) })).status, 201);

  const auth = await post(first._id, guestDevice, { displayName: 'Fake' }, sessionToken);
  assert.equal(auth.status, 201);
  assert.equal(auth.data.comment.displayName, 'Real Reporter');
  assert.equal(String((await Comment.findById(auth.data.comment.id)).author), String(reporter._id));
  for (let i = 0; i < 3; i += 1) assert.equal((await post(first._id, guestDevice, {}, sessionToken)).status, 201);

  assert.equal((await post(second._id, guestDevice)).status, 201);
  assert.equal((await post(first._id, guestDevice)).status, 201);
  const limited = await post(second._id, guestDevice);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, 'COMMENT_RATE_LIMIT');
  assert.equal(limited.data.message, 'You can post three comments per minute. Please try again shortly.');
  assert.equal(Number(limited.headers.get('Retry-After')), limited.data.retryAfterSeconds);
  assert.ok(limited.data.retryAfterSeconds >= 1 && limited.data.retryAfterSeconds <= 60);

  const read = await fetch(`${base}/comments/${created.data.comment.id}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).comment.id, created.data.comment.id);
  const hidden = await Comment.create({ article: privateArticle._id, displayName: 'Hidden', body: 'Private' });
  assert.equal((await fetch(`${base}/comments/${hidden._id}`)).status, 404);
  assert.equal((await fetch(`${base}/comments?articleId=${privateArticle._id}`)).status, 404);

  const page1 = await (await fetch(`${base}/comments?articleId=${first._id}&limit=2`)).json();
  const page2 = await (await fetch(`${base}/comments?articleId=${first._id}&limit=2&cursor=${page1.nextCursor}`)).json();
  assert.equal(page1.comments.length, 2);
  assert.equal(page2.comments.length, 2);
  assert.ok(page1.comments.every(row => !page2.comments.some(other => other.id === row.id)));
  assert.equal((await fetch(`${base}/comments?articleId=${first._id}&limit=1000`)).status, 400);
  assert.equal((await fetch(`${base}/comments?articleId=${first._id}&cursor=bad`)).status, 400);

  const editUrl = `${base}/comments/${created.data.comment.id}`;
  assert.equal((await fetch(editUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Changed' }) })).status, 401);
  assert.equal((await fetch(editUrl, { method: 'DELETE', headers: { Cookie: `wd_session=${sessionToken}` } })).status, 403);
  const editorToken = randomBytes(32).toString('hex');
  await Session.create({ tokenHash: hashToken(editorToken), user: editor._id, expiresAt: new Date(Date.now() + 600000) });
  const edit = await fetch(editUrl, { method: 'PATCH', headers: { Cookie: `wd_session=${editorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: ' Changed ' }) });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).comment.body, 'Changed');
  assert.equal((await fetch(editUrl, { method: 'DELETE', headers: { Cookie: `wd_session=${editorToken}` } })).status, 204);

  const boundaryDevice = device();
  const boundaryKey = createHash('sha256').update(boundaryDevice).digest('hex');
  const fixedNow = new Date();
  await GuestCommentLimit.create({ _id: boundaryKey, successfulAt: [new Date(fixedNow.getTime() - 60000), new Date(fixedNow.getTime() - 30000), new Date(fixedNow.getTime() - 1)], updatedAt: fixedNow });
  assert.equal((await createGuestComment({ articleId: first._id, displayName: 'Boundary', body: 'Accepted', deviceId: boundaryDevice, clock: () => fixedNow })).kind, 'created');
  const boundaryRows = (await GuestCommentLimit.findById(boundaryKey)).successfulAt;
  assert.equal(boundaryRows.length, 3);
  assert.equal(boundaryRows[0].getTime(), fixedNow.getTime() - 30000);
  const boundaryLimit = await createGuestComment({ articleId: first._id, displayName: 'Boundary', body: 'Blocked', deviceId: boundaryDevice, clock: () => fixedNow });
  assert.equal(boundaryLimit.kind, 'limited');
  assert.equal(boundaryLimit.retryAfterSeconds, 30);

  const rollbackDevice = device();
  const rollbackKey = createHash('sha256').update(rollbackDevice).digest('hex');
  await assert.rejects(createGuestComment({ articleId: first._id, displayName: 'Guest', body: ' ', deviceId: rollbackDevice }), error => error.name === 'ValidationError');
  assert.equal(await GuestCommentLimit.findById(rollbackKey), null);

  const raceDevice = device();
  const race = await Promise.all(Array.from({ length: 10 }, () => post(first._id, raceDevice)));
  assert.equal(race.filter(result => result.status === 201).length, 3, JSON.stringify(race.map(result => result.status)));
  assert.equal(race.filter(result => result.status === 429).length, 7);
  const raceKey = createHash('sha256').update(raceDevice).digest('hex');
  assert.equal((await GuestCommentLimit.findById(raceKey)).successfulAt.length, 3);
  assert.equal(await Comment.countDocuments({ _id: { $in: race.filter(result => result.status === 201).map(result => result.data.comment.id) } }), 3);
});
