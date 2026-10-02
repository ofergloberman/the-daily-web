const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const User = require('../models/User');
const Article = require('../models/Article');
const Comment = require('../models/Comment');

test('models reject invalid roles, statuses and empty comments; drafts stay separate', async () => {
  const user = new User({ username: ' Writer ', displayName: 'Writer' });
  await user.setPassword('test-password');
  await user.validate();
  assert.equal(user.username, 'writer');
  assert.equal(user.role, 'guest');
  assert.equal(user.toJSON().passwordHash, undefined);
  user.role = 'admin';
  await assert.rejects(user.validate(), error => Boolean(error.errors.role));
  const article = new Article({ author: new mongoose.Types.ObjectId(), published: { title: 'Approved' } });
  article.draft.title = 'Work in progress';
  assert.equal(article.published.title, 'Approved');
  assert.equal(article.status, 'draft');
  await article.validate();
  article.status = 'unknown';
  await assert.rejects(article.validate(), error => Boolean(error.errors.status));
  const comment = new Comment({ article: article._id, displayName: 'Guest', body: '   ' });
  await assert.rejects(comment.validate(), error => Boolean(error.errors.body));
});

test('HTTP foundation renders, exposes placeholders and handles invalid requests', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base)).text(), /The Daily Web/);
  assert.equal((await fetch(`${base}/health`)).status, 503);
  assert.equal((await fetch(`${base}/auth`)).status, 200);
  for (const route of ['/articles', '/comments']) {
    assert.equal((await fetch(base + route)).status, 501);
  }
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  const invalid = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'INVALID_JSON');
});
