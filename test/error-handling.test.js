const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const User = require('../models/User');
const Session = require('../models/Session');
const Comment = require('../models/Comment');
const comments = require('../services/comments');
const operations = require('../models/userMaintenance');
const { logEvent } = require('../helpers/logging');

const secret = 'mongodb://private-user:private-password@private-host token=private-token';
const id = 'a'.repeat(24);
function capture(t) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) t.mock.method(console, level, line => lines.push(line));
  t.after(() => assert.doesNotMatch(lines.join('\n'), /private-|personal-comment|personal-name/));
  return lines;
}
async function listen(t) {
  const old = process.env.APP_ORIGIN;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  t.after(async () => {
    if (old === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = old;
    await new Promise(resolve => server.close(resolve));
  });
  return { base, post: (path, body, type = 'application/json', extra = {}) => fetch(base + path, {
    method: 'POST', headers: { Origin: base, 'Content-Type': type, ...extra }, body
  }) };
}

test('logging allowlist excludes arbitrary fields, unsafe IDs and exception details', t => {
  const lines = capture(t);
  logEvent('error', 'request.failed', { outcome: 'failure', reason: 'INTERNAL_SERVER_ERROR',
    status: 500, actorId: id, userId: secret, scope: secret, method: secret,
    password: secret, token: secret, body: 'personal-comment', error: new Error(secret), errorType: secret, endpoint: secret });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), ['actorId', 'event', 'level', 'outcome', 'reason', 'status', 'timestamp']);
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
});

test('auth database failures, invalid input, parser errors and CSRF have safe controlled responses', async t => {
  const lines = capture(t);
  const { base, post } = await listen(t);
  t.mock.method(User, 'findOne', () => { throw new Error(secret); });
  t.mock.method(Session, 'findOne', () => { throw new Error(secret); });
  for (const [path, body, status, code] of [
    ['/auth/login', JSON.stringify({ username: 'personal-name', password: 'private-password' }), 500, 'INTERNAL_SERVER_ERROR'],
    ['/auth/login', '{}', 400, 'INVALID_INPUT'],
    ['/comments', '{', 400, 'INVALID_JSON'],
    ['/comments', JSON.stringify({ body: 'x'.repeat(110000) }), 413, 'PAYLOAD_TOO_LARGE']
  ]) {
    const response = await post(path, body);
    assert.equal(response.status, status);
    const data = await response.json();
    assert.equal(data.error, code);
    assert.equal(typeof data.message, 'string');
    assert.doesNotMatch(JSON.stringify(data), /private-|personal-/);
  }
  const html = await post('/auth/login', 'username=personal-name&password=private-password', 'application/x-www-form-urlencoded');
  assert.equal(html.status, 500);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const page = await html.text();
  assert.match(page, /try again later/);
  assert.doesNotMatch(page, /private-|personal-/);
  const session = await fetch(base + '/auth/me', { headers: { Cookie: `wd_session=${'b'.repeat(64)}` } });
  assert.equal(session.status, 500);
  await session.json();
  const csrf = await post('/comments', '{}', 'application/json', { Origin: 'https://other.example' });
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).error, 'CSRF_REJECTED');
  const healthy = await fetch(base + '/health');
  assert.ok([200, 503].includes(healthy.status));
  await healthy.json();
  const entries = lines.map(JSON.parse);
  assert.equal(entries.filter(e => e.event === 'request.failed').length, 3);
  assert.ok(entries.some(e => e.endpoint === '/auth/login' && e.errorType === 'Error'));
  assert.ok(entries.some(e => e.reason === 'INVALID_JSON'));
  assert.ok(entries.some(e => e.reason === 'PAYLOAD_TOO_LARGE'));
  assert.ok(entries.some(e => e.event === 'csrf.rejected'));
});

test('invalid credentials have the same public response and logs for missing accounts and wrong passwords', async t => {
  const lines = capture(t);
  const { post } = await listen(t);
  let user = null;
  t.mock.method(User, 'findOne', () => ({ select: async () => user }));
  let previous;
  for (const value of [null, { role: 'reporter', verifyPassword: async () => false }]) {
    user = value;
    const response = await post('/auth/login', JSON.stringify({ username: 'personal-name', password: 'private-password' }));
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.error, 'INVALID_CREDENTIALS');
    if (previous) assert.deepEqual(data, previous);
    previous = data;
  }
  assert.equal(lines.length, 2);
  assert.ok(lines.map(JSON.parse).every(e => e.event === 'auth.login' && e.reason === 'INVALID_CREDENTIALS'));
});

test('comment operations log committed mutations without content; failures are controlled', async t => {
  const lines = capture(t);
  const { post } = await listen(t);
  let outcome = { kind: 'created', comment: { id, articleId: id, body: 'personal-comment', displayName: 'personal-name' } };
  t.mock.method(comments, 'createGuestComment', async () => outcome);
  const payload = JSON.stringify({ articleId: id, body: 'personal-comment', displayName: 'personal-name' });
  const created = await post('/comments', payload);
  assert.equal(created.status, 201);
  await created.json();
  outcome = { kind: 'limited', retryAfterSeconds: 12 };
  const limited = await post('/comments', payload);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '12');
  assert.equal((await limited.json()).retryAfterSeconds, 12);
  t.mock.method(comments, 'createGuestComment', async () => { throw new Error(secret); });
  const failed = await post('/comments', payload);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, 'INTERNAL_SERVER_ERROR');

  // Exercise mutation controllers with the same server-authenticated identity.
  const controller = require('../controllers/commentsController');
  const row = { _id: id, article: id, body: 'personal-comment', displayName: 'personal-name', createdAt: new Date() };
  t.mock.method(Comment, 'findByIdAndUpdate', async () => row);
  t.mock.method(Comment, 'findByIdAndDelete', async () => row);
  const req = { params: { id }, body: { body: 'personal-comment' }, user: { id }, method: 'PATCH' };
  let status;
  const res = { status(value) { status = value; return this; }, json() {}, end() {} };
  const next = error => { throw error; };
  await controller.update(req, res, next);
  await controller.remove(req, res, next);
  assert.equal(status, 204);
  t.mock.method(Comment, 'findByIdAndUpdate', async () => { throw Object.assign(new Error(secret), { name: 'ValidationError' }); });
  await controller.update(req, res, next);
  assert.equal(status, 400);
  const entries = lines.map(JSON.parse);
  for (const event of ['comment.create', 'comment.update', 'comment.delete']) {
    assert.equal(entries.filter(e => e.event === event && e.outcome === 'success').length, 1);
  }
  assert.equal(entries.filter(e => e.event === 'request.failed').length, 1);
});

test('account logs follow commit, do not duplicate transaction retries, and classify failures safely', async t => {
  const lines = capture(t);
  const user = new User({ _id: id, username: 'personal-name', displayName: 'personal-name', role: 'reporter' });
  t.mock.method(User, 'findOne', () => ({ session: async () => user }));
  t.mock.method(User.prototype, 'save', async function () { return this; });
  t.mock.method(Session, 'deleteMany', async () => ({}));
  t.mock.method(mongoose.connection, 'transaction', async callback => {
    await callback({});
    assert.equal(lines.length, 0, 'No success log inside the transaction callback');
    return callback({});
  });
  await operations.updateUser({ id }, { displayName: 'personal-name' });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'account.update');
  t.mock.method(mongoose.connection, 'transaction', async () => { throw new Error(secret); });
  await assert.rejects(operations.resetPassword({ id }, 'private-password'), { code: 'DATABASE_FAILURE' });
  assert.equal(JSON.parse(lines[1]).reason, 'DATABASE_FAILURE');
  assert.equal(JSON.parse(lines[1]).outcome, 'failure');
  t.mock.method(User.prototype, 'save', async () => { throw Object.assign(new Error(secret), { code: 11000 }); });
  await assert.rejects(operations.createUser({ username: 'personal-name', displayName: 'personal-name', role: 'reporter' }, 'private-password'), { code: 'DUPLICATE_USERNAME' });
  assert.equal(JSON.parse(lines[2]).reason, 'DUPLICATE_USERNAME');
});
