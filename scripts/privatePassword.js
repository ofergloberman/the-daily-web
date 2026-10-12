const { createInterface } = require('node:readline');
const { Writable } = require('node:stream');

async function privatePassword(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('Password entry requires an interactive terminal.');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: muted, terminal: true });
  const ask = prompt => new Promise((resolve, reject) => {
    output.write(prompt);
    const closed = () => reject(new Error('Password entry cancelled.'));
    reader.once('close', closed);
    reader.question('', answer => { reader.off('close', closed); output.write('\n'); resolve(answer); });
  });
  try {
    const password = await ask('Password (8–128 characters): ');
    if (password !== await ask('Confirm password: ')) throw new Error('Passwords do not match.');
    return password;
  } finally { reader.close(); }
}
module.exports = { privatePassword };
