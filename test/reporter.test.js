const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');

test('Reporter draft routes enforce role, ownership, state and field validation', async t => {
  const reporterId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const articleId = new mongoose.Types.ObjectId();
  const reporter = { _id: reporterId, displayName: 'Reporter One', role: 'reporter' };
  const other = { _id: otherId, displayName: 'Reporter Two', role: 'reporter' };
  const editor = { _id: new mongoose.Types.ObjectId(), displayName: 'Editor', role: 'editor' };
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };
  const users = new Map([[hashToken(tokens.a), reporter], [hashToken(tokens.b), other], [hashToken(tokens.c), editor]]);
  const articles = [];

  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));
  t.mock.method(Article, 'create', async data => {
    const article = new Article({ ...data, _id: articleId });
    article.updatedAt = new Date();
    articles.push(article);
    return article;
  });
  t.mock.method(Article, 'find', ({ author }) => ({
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
    async lean() { return articles.filter(a => a.author.equals(author)).map(a => a.toObject()); }
  }));
  t.mock.method(Article, 'findOne', async query => articles.find(a =>
    String(a._id) === query._id && a.author.equals(query.author) && a.status === query.status
  ) || null);
  t.mock.method(Article, 'findOneAndUpdate', async (query, update) => {
    const article = articles.find(a => String(a._id) === query._id && a.author.equals(query.author) && a.status === query.status);
    if (!article) return null;
    for (const [path, value] of Object.entries(update.$set)) article.draft[path.slice(6)] = value;
    article.updatedAt = new Date();
    return article;
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = token => ({ Cookie: `wd_session=${token}` });
  const draft = { title: 'News', summary: 'Summary', body: 'Story', category: 'World', imageUrl: 'https://example.com/photo.jpg' };
  const patch = (token, id, body) => fetch(`${base}/reporter/articles/${id}/draft`, {
    method: 'PATCH', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  assert.equal((await fetch(`${base}/reporter`)).status, 401);
  assert.equal((await fetch(`${base}/reporter`, { headers: headers(tokens.c) })).status, 403);
  assert.equal((await fetch(`${base}/reporter`, { headers: headers(tokens.a) })).status, 200);
  assert.equal((await fetch(`${base}/reporter?page=bad`, { headers: headers(tokens.a) })).status, 400);
  const created = await fetch(`${base}/reporter/articles`, {
    method: 'POST', headers: { ...headers(tokens.a), 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: String(otherId), status: 'published' })
  });
  assert.equal(created.status, 201);
  assert.equal(articles[0].author.equals(reporterId), true);
  assert.equal(articles[0].status, 'draft');
  assert.equal((await fetch(`${base}/reporter/articles`, { headers: headers(tokens.a) }).then(r => r.json())).articles.length, 1);
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.b) })).status, 404);
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) })).status, 200);
  assert.equal((await patch(tokens.b, articleId, draft)).status, 404);
  assert.equal((await patch(tokens.a, 'bad-id', draft)).status, 400);
  assert.equal((await patch(tokens.a, articleId, { ...draft, status: 'published' })).status, 400);
  assert.equal((await patch(tokens.a, articleId, { ...draft, imageUrl: 'x'.repeat(2049) })).status, 400);
  assert.equal((await patch(tokens.a, articleId, { ...draft, imageUrl: {} })).status, 400);
  for (const imageUrl of ['https://', 'unfinished image URL', 'javascript:alert(1)']) {
    assert.equal((await patch(tokens.a, articleId, { ...draft, body: 'Keep my latest writing', imageUrl })).status, 200);
    assert.equal(articles[0].draft.body, 'Keep my latest writing');
    assert.equal(articles[0].draft.imageUrl, imageUrl);
    assert.equal(articles[0].published, null);
    const page = await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) }).then(r => r.text());
    assert.ok(page.includes('Keep my latest writing'));
    assert.ok(page.includes(`value="${imageUrl}"`));
  }
  const limits = { title: 200, summary: 500, body: 50000, category: 80, imageUrl: 2048 };
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal((await patch(tokens.a, articleId, { ...draft, [field]: '' })).status, 200, `${field} may be empty in a draft`);
    assert.equal((await patch(tokens.a, articleId, { ...draft, [field]: 'x'.repeat(limit) })).status, 200, `${field} accepts its limit`);
    assert.equal((await patch(tokens.a, articleId, { ...draft, [field]: 'x'.repeat(limit + 1) })).status, 400, `${field} rejects excess length`);
    assert.equal((await patch(tokens.a, articleId, { ...draft, [field]: 42 })).status, 400, `${field} must be a string`);
    const missing = { ...draft };
    delete missing[field];
    assert.equal((await patch(tokens.a, articleId, missing)).status, 400, `${field} is required in the save payload`);
  }
  assert.equal((await patch(tokens.a, articleId, draft)).status, 200);
  assert.equal(articles[0].draft.title, 'News');
  articles[0].status = 'pending';
  assert.equal((await patch(tokens.a, articleId, { ...draft, title: 'Changed after submit' })).status, 404);
  assert.equal(articles[0].draft.title, 'News');
});
