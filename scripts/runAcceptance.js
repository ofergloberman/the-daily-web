// Use an environment variable; never place database credentials in this file.
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const source = process.env.ACCEPTANCE_MONGODB_URI;
if (!source) throw new Error('Set ACCEPTANCE_MONGODB_URI to the target cluster URI.');
const env = { ...process.env };
for (const [key, prefix] of Object.entries({ COMMENTS_TEST_MONGODB_URI: 'comments', USERS_TEST_MONGODB_URI: 'users', PERSISTENCE_TEST_MONGODB_URI: 'persistence' })) {
  const url = new URL(source);
  // This Atlas tier limits database names to 38 bytes; keep even the longest prefix below it.
  url.pathname = `/the_daily_web_${prefix}_test_${randomBytes(3).toString('hex')}`;
  env[key] = url.href;
}
fs.mkdirSync(path.join(__dirname, '../docs/verification'), { recursive: true });
const args = process.argv.slice(2);
const result = spawn(process.execPath, ['--test', '--test-reporter=tap', ...(args.length ? args : ['test/*.test.js'])], {
  env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
const logPath = path.join(__dirname, `../docs/verification/acceptance-${Date.now()}.txt`);
fs.writeFileSync(logPath, '');
function record(chunk) {
  const output = String(chunk).replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/g, '[database URI redacted]');
  fs.appendFileSync(logPath, output);
  process.stdout.write(output);
}
result.stdout.on('data', record);
result.stderr.on('data', record);
result.once('error', error => { record(`Acceptance runner failed: ${error.code}\n`); process.exitCode = 1; });
result.once('exit', code => { process.exitCode = code ?? 1; });
