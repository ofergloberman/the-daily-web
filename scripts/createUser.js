// Compatibility command: positional account details with the shared private prompt.
const { run } = require('./maintainUsers');
const [username, displayName, role, offline, ...extra] = process.argv.slice(2);
if (!username || !displayName || !role || offline !== '--offline' || extra.length) {
  console.error('Usage: npm run create-user -- <username> <displayName> <reporter|editor> --offline');
  process.exitCode = 1;
} else {
  run(['create', '--username', username, '--display-name', displayName, '--role', role, '--offline']);
}
