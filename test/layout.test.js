const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');

test('shared header reflects guest, reporter and editor sessions', async t => {
  const tokens = { reporter: 'a'.repeat(64), editor: 'b'.repeat(64) };
  const users = new Map([
    [hashToken(tokens.reporter), { _id: new mongoose.Types.ObjectId(), displayName: 'Rina Reporter', role: 'reporter' }],
    [hashToken(tokens.editor), { _id: new mongoose.Types.ObjectId(), displayName: 'Eli Editor', role: 'editor' }]
  ]);
  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const home = async token => (await fetch(`http://127.0.0.1:${server.address().port}/`, token ? { headers: { Cookie: `wd_session=${token}` } } : {})).text();

  const guest = await home();
  assert.match(guest, /<link rel="stylesheet" href="\/base.css">/);
  assert.match(guest, /href="\/auth">Sign in</);
  assert.doesNotMatch(guest, /Sign out|href="\/reporter"|href="\/editor"/);
  assert.match(guest, /<footer class="site-footer">/);

  const reporter = await home(tokens.reporter);
  assert.match(reporter, /Rina Reporter/);
  assert.match(reporter, /href="\/reporter">My articles</);
  assert.match(reporter, /action="\/auth\/logout"/);
  assert.doesNotMatch(reporter, /href="\/editor"|>Sign in</);

  const editor = await home(tokens.editor);
  assert.match(editor, /href="\/editor">Editor desk</);
  assert.doesNotMatch(editor, /href="\/reporter"/);
});
