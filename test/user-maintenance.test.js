const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const User = require('../models/User');
const { parseArguments, readPrivate } = require('../scripts/maintainUsers');
const maintenance = require('../models/userMaintenance');

test('maintenance rejects unsafe fields, ambiguous lookup, invalid roles and bounds before database use', async () => {
  for (const role of ['guest', 'admin', '', null]) {
    await assert.rejects(maintenance.createUser({ username: 'writer', displayName: 'Writer', role }, 'test-password'), { code: 'INVALID_INPUT' });
  }
  for (const selector of [{}, { id: 'x' }, { username: 'x', id: 'a'.repeat(24) }, { username: { $ne: null } }]) {
    await assert.rejects(maintenance.readUser(selector), { code: 'INVALID_INPUT' });
  }
  for (const patch of [{}, { passwordHash: 'secret' }, { authVersion: 0 }, { displayName: '\nName' }, { username: ' ' }]) {
    await assert.rejects(maintenance.updateUser({ username: 'writer' }, patch), { code: 'INVALID_INPUT' });
  }
  for (const limit of [0, 101, 1.5, '20']) await assert.rejects(maintenance.listUsers({ limit }), { code: 'INVALID_INPUT' });
  await assert.rejects(maintenance.resetPassword({ username: 'writer' }, 'short'), { code: 'INVALID_INPUT' });
  await assert.rejects(maintenance.deleteUser({ username: 'writer' }), /offline maintenance/);
});

test('database errors are sanitized and duplicates have a distinct error', async t => {
  t.mock.method(User, 'findOne', () => ({ session: async () => { throw new Error('mongodb://secret:password@host tokenHash scrypt:secret'); } }));
  await assert.rejects(maintenance.readUser({ username: 'writer' }), error => error.code === 'DATABASE_FAILURE' && !/secret|tokenHash|scrypt/.test(error.message));
  t.mock.method(User, 'init', async () => {});
  t.mock.method(User.prototype, 'save', async () => { const error = new Error('sensitive data'); error.code = 11000; throw error; });
  await assert.rejects(maintenance.createUser({ username: 'writer', displayName: 'Writer', role: 'reporter' }, 'test-password'), { code: 'DUPLICATE_USERNAME', message: 'Username already exists.' });
});

test('CLI rejects password arguments, unknown options, duplicate selectors and unacknowledged deletion', () => {
  for (const args of [['read', '--username', 'a', '--password', 'secret'], ['read', '--username', 'a', '--username', 'b'],
    ['read', '--id', 'a', '--username', 'a'], ['create', '--username', 'a', '--display-name', 'A', '--role', 'guest'],
    ['delete', '--username', 'a'], ['update', '--username'], ['toString']]) assert.throws(() => parseArguments(args));
  const result = spawnSync(process.execPath, ['scripts/maintainUsers.js', 'read', '--password', 'not-for-output'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /not-for-output/);
});

test('private password entry does not echo, restores terminal and handles cancellation', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let displayed = '';
  output.on('data', data => { displayed += data; });
  const result = readPrivate('Password: ', input, output);
  input.emit('keypress', 'private-password', {});
  input.emit('keypress', '', { name: 'return' });
  assert.equal(await result, 'private-password');
  assert.equal(displayed, 'Password: \n');
  assert.equal(input.isRaw, false);
  const cancelled = readPrivate('Password: ', input, output);
  input.emit('keypress', '', { name: 'c', ctrl: true });
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(input.isRaw, false);
  assert.throws(() => readPrivate('Password: ', {}, {}), /interactive terminal/);
});
