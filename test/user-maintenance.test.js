const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const User = require('../models/User');
const operations = require('../models/userMaintenance');
const { parse } = require('../scripts/maintainUsers');
const { privatePassword } = require('../scripts/privatePassword');

test('maintenance rejects invalid profiles, selectors, passwords and listing bounds before database access', async () => {
  const valid = { username: 'writer', displayName: 'Writer', role: 'reporter' };
  for (const change of [{ role: 'guest' }, { role: 'admin' }, { username: ' ' }, { username: 'two words' },
    { username: 'x'.repeat(51) }, { displayName: '\nWriter' }, { displayName: ' ' },
    { displayName: 'x'.repeat(101) }, { passwordHash: 'hidden' }]) {
    await assert.rejects(operations.createUser({ ...valid, ...change }, 'test-password'), { code: 'INVALID_INPUT' });
    await assert.rejects(operations.updateUser({ username: 'writer' }, change), { code: 'INVALID_INPUT' });
  }
  for (const selector of [{}, { id: 'bad' }, { id: 'a'.repeat(24), username: 'writer' }, { role: 'editor' }]) {
    await assert.rejects(operations.readUser(selector), { code: 'INVALID_INPUT' });
  }
  for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 10001 }, { limit: '20' }, { search: {} }, { password: 'secret' }]) {
    await assert.rejects(operations.listUsers(options), { code: 'INVALID_INPUT' });
  }
  for (const password of ['short', 'x'.repeat(129), undefined]) {
    await assert.rejects(operations.resetPassword({ username: 'writer' }, password), { code: 'INVALID_INPUT' });
  }
});

test('database failures are redacted', async t => {
  t.mock.method(User, 'findOne', () => { throw new Error('mongodb://user:secret@private-host token=secret'); });
  await assert.rejects(operations.readUser({ username: 'writer' }), error => {
    assert.equal(error.code, 'DATABASE_FAILURE');
    assert.doesNotMatch(error.message, /secret|private-host/);
    return true;
  });
});

test('CLI rejects unexpected flags, duplicate flags and online writes', () => {
  for (const args of [['delete', '--username', 'writer'], ['read', '--password', 'secret'],
    ['list', '--limit', '20', '--limit', '30'], ['update', '--offline', 'extra'], ['create', '--username']]) {
    assert.throws(() => parse(args));
  }
  assert.equal(parse(['delete', '--username', 'writer', '--offline']).options.offline, true);
  const result = spawnSync(process.execPath, ['scripts/maintainUsers.js', 'read', '--password', 'do-not-print'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print/);
});

test('private password entry hides typing, confirms, rejects mismatch and refuses pipes', async () => {
  await assert.rejects(privatePassword(new PassThrough(), new PassThrough()), /interactive terminal/);
  async function prompt(confirm) {
    const input = new PassThrough();
    input.isTTY = true;
    let printed = '';
    const output = new Writable({ write(chunk, _encoding, done) {
      printed += chunk;
      if (String(chunk).startsWith('Password (')) setImmediate(() => input.write('private-password\n'));
      if (String(chunk).startsWith('Confirm')) setImmediate(() => input.write(confirm + '\n'));
      done();
    } });
    output.isTTY = true;
    try { return await privatePassword(input, output); }
    finally { input.destroy(); assert.doesNotMatch(printed, /private-password/); }
  }
  assert.equal(await prompt('private-password'), 'private-password');
  await assert.rejects(prompt('different'), /do not match/);
});
