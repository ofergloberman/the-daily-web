const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { assertDemoUri, readDemoPasswords, redactConnectionStrings } = require('../scripts/demoGuard');

test('redactConnectionStrings hides every MongoDB connection string in a message', () => {
  const message = 'Cannot reach mongodb://user:secret@db.example:27017/app_demo?replicaSet=rs0 or mongodb+srv://u:p@cluster.example/x_demo.';
  const redacted = redactConnectionStrings(message);
  assert.doesNotMatch(redacted, /mongodb|secret|db\.example|cluster/);
  assert.equal(redacted.match(/\[connection string hidden\]/g).length, 2);
  assert.equal(redactConnectionStrings('Refusing to seed database "app".'), 'Refusing to seed database "app".');
});

const VALID_PASSWORD = 'demo-pass-123';

test('assertDemoUri accepts databases whose name ends in _demo', () => {
  assert.equal(assertDemoUri('mongodb://h:27017/app_demo?x=1'), 'app_demo');
  assert.equal(assertDemoUri('mongodb+srv://u:p@cluster.example.net/app_demo?retryWrites=true'), 'app_demo');
});

test('assertDemoUri rejects a missing, empty or non-demo database name', () => {
  const rejected = [
    undefined, '', 'mongodb://h:27017', 'mongodb://h:27017/', 'mongodb://h:27017/?x=1',
    'mongodb://h:27017/prod', 'mongodb://h:27017/app_dev3', 'mongodb://h:27017/demo_prod', 'mongodb://h:27017/the_daily_web'
  ];
  for (const uri of rejected) assert.throws(() => assertDemoUri(uri), /Refusing to seed database/, String(uri));
});

test('credentials with a raw "@" or "/" cannot hide the real database name', () => {
  assert.throws(() => assertDemoUri('mongodb://user:pa/app_demo@host/prod'), /"prod"/);
  assert.throws(() => assertDemoUri('mongodb://user:p@ss@host/prod'), /"prod"/);
  assert.equal(assertDemoUri('mongodb://user:p@ss@host/app_demo'), 'app_demo');
  assert.equal(assertDemoUri('mongodb://user:pa/prod@host/app_demo'), 'app_demo');
});

test('an "@" or "/" inside the query string cannot hide the real database name', () => {
  assert.throws(() => assertDemoUri('mongodb://host/prod?appName=x@y/app_demo'), /"prod"/);
  assert.equal(assertDemoUri('mongodb://host/app_demo?appName=x@y/prod'), 'app_demo');
});

test('readDemoPasswords returns one password per role', () => {
  const passwords = readDemoPasswords({ DEMO_REPORTER_PASSWORD: VALID_PASSWORD, DEMO_EDITOR_PASSWORD: `${VALID_PASSWORD}-editor` });
  assert.deepEqual(passwords, { reporter: VALID_PASSWORD, editor: `${VALID_PASSWORD}-editor` });
});

test('readDemoPasswords rejects missing, 7 and 129 character passwords and names only the variable', () => {
  const tooShort = 'x'.repeat(7);
  const tooLong = 'y'.repeat(129);
  const cases = [
    [{ DEMO_EDITOR_PASSWORD: VALID_PASSWORD }, 'DEMO_REPORTER_PASSWORD', undefined],
    [{ DEMO_REPORTER_PASSWORD: VALID_PASSWORD }, 'DEMO_EDITOR_PASSWORD', undefined],
    [{ DEMO_REPORTER_PASSWORD: tooShort, DEMO_EDITOR_PASSWORD: VALID_PASSWORD }, 'DEMO_REPORTER_PASSWORD', tooShort],
    [{ DEMO_REPORTER_PASSWORD: VALID_PASSWORD, DEMO_EDITOR_PASSWORD: tooLong }, 'DEMO_EDITOR_PASSWORD', tooLong]
  ];
  for (const [env, variable, secret] of cases) {
    assert.throws(() => readDemoPasswords(env), error => {
      assert.ok(error.message.includes(variable), error.message);
      if (secret) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('readDemoPasswords accepts the 8 and 128 character limits', () => {
  const env = { DEMO_REPORTER_PASSWORD: 'x'.repeat(8), DEMO_EDITOR_PASSWORD: 'y'.repeat(128) };
  assert.deepEqual(readDemoPasswords(env), { reporter: env.DEMO_REPORTER_PASSWORD, editor: env.DEMO_EDITOR_PASSWORD });
});

test('importing the seed script neither connects nor runs main', () => {
  require('../scripts/seedDemoFixtures');
  assert.equal(mongoose.connection.readyState, 0);
});

const DEMO_URI = 'mongodb://h:27017/app_demo';
const VALID_ENV = { MONGODB_URI: DEMO_URI, DEMO_REPORTER_PASSWORD: VALID_PASSWORD, DEMO_EDITOR_PASSWORD: VALID_PASSWORD };

function countingConnect() {
  const calls = [];
  return { calls, connect: async uri => { calls.push(uri); } };
}

test('startSeed rejects a bad or non-demo URI without connecting', async () => {
  const { startSeed } = require('../scripts/seedDemoFixtures');
  for (const uri of [undefined, '', 'mongodb://h:27017/prod', 'mongodb://h:27017/app_dev3']) {
    const { calls, connect } = countingConnect();
    await assert.rejects(startSeed({ env: { ...VALID_ENV, MONGODB_URI: uri }, connect }), /Refusing to seed database/, String(uri));
    assert.equal(calls.length, 0, String(uri));
  }
});

test('startSeed rejects a missing or short password without connecting', async () => {
  const { startSeed } = require('../scripts/seedDemoFixtures');
  const badEnvs = [
    { MONGODB_URI: DEMO_URI, DEMO_EDITOR_PASSWORD: VALID_PASSWORD },
    { MONGODB_URI: DEMO_URI, DEMO_REPORTER_PASSWORD: VALID_PASSWORD },
    { ...VALID_ENV, DEMO_REPORTER_PASSWORD: 'x'.repeat(7) },
    { ...VALID_ENV, DEMO_EDITOR_PASSWORD: '' }
  ];
  for (const env of badEnvs) {
    const { calls, connect } = countingConnect();
    await assert.rejects(startSeed({ env, connect }), /must be set to 8-128 characters/);
    assert.equal(calls.length, 0);
  }
});

test('startSeed connects exactly once with the URI when the input is valid', async () => {
  const { startSeed } = require('../scripts/seedDemoFixtures');
  const { calls, connect } = countingConnect();
  const result = await startSeed({ env: VALID_ENV, connect });
  assert.deepEqual(calls, [DEMO_URI]);
  assert.equal(result.dbName, 'app_demo');
  assert.deepEqual(result.passwords, { reporter: VALID_PASSWORD, editor: VALID_PASSWORD });
});
