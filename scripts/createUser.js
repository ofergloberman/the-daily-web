// Preserve the positional command; credentials now use a private prompt.
const { run } = require('./maintainUsers');
const [username, displayName, role, ...extra] = process.argv.slice(2);
if (!username || !displayName || !role || extra.length) {
  console.error('Usage: npm run create-user -- <username> <displayName> <reporter|editor>');
  process.exitCode = 1;
} else {
  run(['create', '--username', username, '--display-name', displayName, '--role', role]);
}
