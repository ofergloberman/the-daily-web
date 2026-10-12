const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const operations = require('../models/userMaintenance');
const { privatePassword } = require('./privatePassword');
const { logEvent } = require('../helpers/logging');

const usage = `Usage: npm run users -- <command> [options]
Commands: create, read, list, update, reset-password, delete
Selector: --id <id> OR --username <username>
create: --username <name> --display-name <name> --role <reporter|editor>
update: selector plus --new-username <name>, --display-name <name>, --role <reporter|editor>
list: --search <username-prefix> --limit <1-100> --offset <0-10000>
All writes require --offline after stopping all application and seed writers.
Passwords are prompted privately; password arguments and environment variables are unsupported.`;

function parse(args) {
  const [command, ...rest] = args;
  const allowed = {
    create: ['username', 'display-name', 'role', 'offline'], read: ['id', 'username'],
    list: ['search', 'limit', 'offset'], update: ['id', 'username', 'new-username', 'display-name', 'role', 'offline'],
    'reset-password': ['id', 'username', 'offline'], delete: ['id', 'username', 'offline']
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(usage);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index].slice(2);
    if (!rest[index].startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown or repeated option.\n' + usage);
    if (key === 'offline') options[key] = true;
    else {
      const value = rest[++index];
      if (value === undefined || value.startsWith('--')) throw new Error('Missing option value.');
      options[key] = value;
    }
  }
  if (!['read', 'list'].includes(command) && !options.offline) throw new Error('Stop all application/seed writers, then pass --offline.');
  return { command, options };
}
async function main(args = process.argv.slice(2)) {
  const { command, options } = parse(args);
  const selector = {};
  for (const field of ['id', 'username']) if (Object.hasOwn(options, field)) selector[field] = options[field];
  const changes = {};
  for (const [option, field] of [['new-username', 'username'], ['display-name', 'displayName'], ['role', 'role']]) {
    if (Object.hasOwn(options, option)) changes[field] = options[option];
  }
  const password = ['create', 'reset-password'].includes(command) ? await privatePassword() : undefined;
  try {
    await connectDatabase(process.env.MONGODB_URI);
    await require('../models/User').init();
  } catch (error) {
    logEvent('error', `account.${command}`, { outcome: 'failure', reason: 'DATABASE_FAILURE', scope: 'maintenance' });
    throw error;
  }
  let result;
  switch (command) {
    case 'create': result = await operations.createUser({ username: options.username, ...changes }, password); break;
    case 'read': result = await operations.readUser(selector); break;
    case 'list': result = await operations.listUsers({ ...(options.search !== undefined ? { search: options.search } : {}),
      ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}),
      ...(options.offset !== undefined ? { offset: Number(options.offset) } : {}) }); break;
    case 'update': result = await operations.updateUser(selector, changes); break;
    case 'reset-password': result = await operations.resetPassword(selector, password); break;
    case 'delete': result = await operations.deleteUser(selector); break;
  }
  console.log(JSON.stringify(result, null, 2));
}
async function run(args) {
  try { await main(args); }
  catch (error) {
    // Database errors can contain connection credentials. Never print those messages.
    const safeMessages = new Set([usage, 'Unknown or repeated option.\n' + usage,
      'Missing option value.', 'Stop all application/seed writers, then pass --offline.',
      'Password entry requires an interactive terminal.', 'Password entry cancelled.', 'Passwords do not match.']);
    console.error(error instanceof operations.MaintenanceError ? `${error.code}: ${error.message}` :
      (safeMessages.has(error.message)
        ? error.message : 'Maintenance failed; check database configuration and availability.'));
    process.exitCode = 1;
  } finally {
    try { await mongoose.disconnect(); }
    catch {
      logEvent('error', 'request.failed', { outcome: 'failure', reason: 'DATABASE_FAILURE', scope: 'maintenance' });
      console.error('Could not close the database connection cleanly.');
      process.exitCode = 1;
    }
  }
}
if (require.main === module) run();
module.exports = { parse, run };
