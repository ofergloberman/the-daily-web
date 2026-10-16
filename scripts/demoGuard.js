const { databaseName } = require('./dev3Guard');
const { PASSWORD_LENGTH } = require('../config/constants');

// Same length rule as User.setPassword (shared constant), checked here so the seed fails before it connects.
const DEMO_DATABASE_SUFFIX = '_demo';

// The demo seed deletes and rewrites data, so it must only ever run against a database named *_demo.
// The name is read from the URI because connecting already writes (transaction probe, index creation).
function assertDemoUri(uri) {
  const name = databaseName(uri);
  if (!name.endsWith(DEMO_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to seed database "${name || '(none in MONGODB_URI)'}". Use a database name ending in ${DEMO_DATABASE_SUFFIX}.`);
  }
  return name;
}

function readPassword(env, variableName) {
  const value = env[variableName];
  if (typeof value !== 'string' || value.length < PASSWORD_LENGTH.min || value.length > PASSWORD_LENGTH.max) {
    throw new Error(`${variableName} must be set to ${PASSWORD_LENGTH.min}-${PASSWORD_LENGTH.max} characters.`);
  }
  return value;
}

function readDemoPasswords(env) {
  return {
    reporter: readPassword(env, 'DEMO_REPORTER_PASSWORD'),
    editor: readPassword(env, 'DEMO_EDITOR_PASSWORD')
  };
}

const CONNECTION_STRING = /mongodb(?:\+srv)?:\/\/\S+/gi;

// A driver message can quote the connection string; scripts print failures through this so the URI never reaches the log.
function redactConnectionStrings(text) {
  return String(text).replace(CONNECTION_STRING, '[connection string hidden]');
}

module.exports = { assertDemoUri, readDemoPasswords, redactConnectionStrings };
