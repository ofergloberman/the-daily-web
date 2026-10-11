const readline = require('node:readline');
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const operations = require('../models/userMaintenance');

const HELP = `Local account maintenance (no public account-management endpoint)
  npm run users -- create --username NAME --display-name NAME --role reporter|editor
  npm run users -- read --id ID | --username NAME
  npm run users -- list [--search PREFIX] [--limit 1..100] [--after USERNAME]
  npm run users -- update --id ID | --username NAME [--new-username NAME] [--display-name NAME] [--role reporter|editor]
  npm run users -- reset-password --id ID | --username NAME
  npm run users -- delete --id ID | --username NAME --offline
Passwords are prompted privately in an interactive terminal and confirmed.
Before deletion, stop ALL application instances and other database writers.
--offline acknowledges that maintenance window; it does not stop them for you.`;

function invalid(message) { throw new operations.MaintenanceError('INVALID_INPUT', message); }
function parseArguments(args) {
  const [command, ...rest] = args;
  const allowed = {
    create: ['username', 'display-name', 'role'], read: ['id', 'username'],
    list: ['search', 'limit', 'after'],
    update: ['id', 'username', 'new-username', 'display-name', 'role'],
    'reset-password': ['id', 'username'], delete: ['id', 'username', 'offline']
  };
  if (!Object.hasOwn(allowed, command)) invalid('Unknown command. Run npm run users -- --help.');
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed[command].includes(name) || Object.hasOwn(options, name)) invalid('Unknown or duplicate option. Run npm run users -- --help.');
    if (name === 'offline') { options.offline = true; continue; }
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) invalid('Option requires a value.');
    options[name] = rest[++i];
  }
  const selector = {};
  if (options.id !== undefined) selector.id = options.id;
  if (options.username !== undefined) selector.username = options.username;
  if (!['create', 'list'].includes(command) && Object.keys(selector).length !== 1) invalid('Supply exactly one of --id or --username.');
  if (command === 'create' && !['username', 'display-name', 'role'].every(key => options[key])) invalid('Creation requires username, display name and role.');
  if (options.role !== undefined && !['reporter', 'editor'].includes(options.role)) invalid('Role must be reporter or editor.');
  if (command === 'delete' && !options.offline) invalid('Stop all application instances and database writers, then acknowledge with --offline.');
  return { command, options, selector };
}

// Raw terminal input disables echo. Restore terminal state on cancellation.
function readPrivate(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) invalid('A private interactive terminal is required to enter passwords.');
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = '';
    readline.emitKeypressEvents(input);
    function finish(error) {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      if (error) { value = ''; reject(error); } else resolve(value);
    }
    function onEnd() { finish(new operations.MaintenanceError('CANCELLED', 'Password entry cancelled.')); }
    function onError() { onEnd(); }
    function onKey(char, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return onEnd();
      if (['return', 'enter'].includes(key.name)) return finish();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && typeof char === 'string' && !/[\x00-\x1f\x7f]/.test(char)) {
        if (value.length + char.length > 128) return finish(new operations.MaintenanceError('INVALID_INPUT', 'Password must be 8 to 128 characters.'));
        value += char;
      }
    }
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) { console.log(HELP); return; }
  const { command, options, selector } = parseArguments(args);
  let password;
  if (['create', 'reset-password'].includes(command)) {
    password = await readPrivate('New password (8-128 characters): ');
    if (password.length < 8) invalid('Password must be 8 to 128 characters.');
    if (password !== await readPrivate('Confirm password: ')) invalid('Passwords do not match.');
  }
  await connectDatabase(process.env.MONGODB_URI);
  let result;
  if (command === 'create') result = await operations.createUser({ username: options.username, displayName: options['display-name'], role: options.role }, password);
  if (command === 'read') result = await operations.readUser(selector);
  if (command === 'list') {
    if (options.limit !== undefined && !/^\d+$/.test(options.limit)) invalid('Limit must be an integer from 1 to 100.');
    result = await operations.listUsers({ ...(options.search !== undefined ? { search: options.search } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}), ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) });
  }
  if (command === 'update') {
    const patch = {};
    for (const [option, field] of [['new-username', 'username'], ['display-name', 'displayName'], ['role', 'role']]) {
      if (options[option] !== undefined) patch[field] = options[option];
    }
    result = await operations.updateUser(selector, patch);
  }
  if (command === 'reset-password') result = await operations.resetPassword(selector, password);
  if (command === 'delete') result = await operations.deleteUser(selector, { offline: options.offline });
  password = undefined;
  console.log(JSON.stringify(result, null, 2));
  if (!['read', 'list'].includes(command)) console.info(`Account maintenance completed: ${command}`);
}

async function run(args) {
  try { await main(args); } catch (error) {
    console.error(error instanceof operations.MaintenanceError ? `${error.code}: ${error.message}` : 'DATABASE_FAILURE: Cannot complete maintenance. Check database configuration, availability and transaction support.');
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) run();
module.exports = { parseArguments, readPrivate, run };
