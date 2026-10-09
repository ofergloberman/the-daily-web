const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');

// Generic in-memory filter matcher supporting the shapes articleWorkflow.js
// issues: exact field equality (including ObjectId/string coercion) and
// `{ $ne: value }` for the pending-lock guard in saveDraftContent.
function matches(doc, filter) {
  for (const [key, value] of Object.entries(filter)) {
    const actual = key === '_id' ? String(doc._id) : key === 'author' ? String(doc.author) : doc[key];
    if (value && typeof value === 'object' && '$ne' in value) {
      if (String(actual) === String(value.$ne)) return false;
    } else if (String(actual) !== String(value)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (!update.$set) return;
  for (const [path, value] of Object.entries(update.$set)) {
    if (path.includes('.')) {
      const [root, sub] = path.split('.');
      doc[root][sub] = value;
    } else {
      doc[path] = value;
    }
  }
  doc.updatedAt = new Date();
}

test('Reporter article routes enforce role, ownership, state transitions and field validation', async t => {
  const reporterId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const reporter = { _id: reporterId, id: String(reporterId), displayName: 'Reporter One', role: 'reporter' };
  const other = { _id: otherId, id: String(otherId), displayName: 'Reporter Two', role: 'reporter' };
  const editor = { _id: new mongoose.Types.ObjectId(), id: '', displayName: 'Editor', role: 'editor' };
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };
  const users = new Map([[hashToken(tokens.a), reporter], [hashToken(tokens.b), other], [hashToken(tokens.c), editor]]);
  const articles = [];

  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));

  t.mock.method(Article, 'create', async data => {
    const article = new Article(data);
    article.updatedAt = new Date();
    articles.push(article);
    return article;
  });

  t.mock.method(Article, 'find', filter => {
    let sorted;
    let skipN = 0;
    let limitN = Infinity;
    const query = {
      select() { return this; },
      sort() {
        sorted = articles.filter(a => matches(a, filter)).sort((x, y) => y.updatedAt - x.updatedAt);
        return this;
      },
      skip(n) { skipN = n; return this; },
      limit(n) { limitN = n; return this; },
      async lean() {
        const list = sorted || articles.filter(a => matches(a, filter));
        return list.slice(skipN, skipN + limitN).map(a => a.toObject());
      }
    };
    return query;
  });

  t.mock.method(Article, 'findOne', async filter => articles.find(a => matches(a, filter)) || null);

  t.mock.method(Article, 'findOneAndUpdate', async (filter, update) => {
    const article = articles.find(a => matches(a, filter));
    if (!article) return null;
    // Validate a throwaway clone first so a rejected update leaves the stored
    // document untouched, matching atomic runValidators behavior.
    const attempt = new Article(article.toObject());
    applyUpdate(attempt, update);
    await attempt.validate();
    applyUpdate(article, update);
    return article;
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = token => ({ Cookie: `wd_session=${token}` });
  const full = { title: 'News', summary: 'Summary', body: 'Story', category: 'World', imageUrl: 'https://example.com/photo.jpg' };
  const patch = (token, id, body) => fetch(`${base}/reporter/articles/${id}/draft`, {
    method: 'PATCH', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const submit = (token, id) => fetch(`${base}/reporter/articles/${id}/submit`, { method: 'POST', headers: headers(token) });

  assert.equal((await fetch(`${base}/reporter`)).status, 401);
  assert.equal((await fetch(`${base}/reporter`, { headers: headers(tokens.c) })).status, 403);
  assert.equal((await fetch(`${base}/reporter`, { headers: headers(tokens.a) })).status, 200);
  assert.equal((await fetch(`${base}/reporter?page=bad`, { headers: headers(tokens.a) })).status, 400);

  const created = await fetch(`${base}/reporter/articles`, {
    method: 'POST', headers: { ...headers(tokens.a), 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: String(otherId), status: 'published' })
  });
  assert.equal(created.status, 201);
  const articleId = articles[0]._id.toString();
  assert.equal(String(articles[0].author), String(reporterId));
  assert.equal(articles[0].status, 'draft');
  assert.equal((await fetch(`${base}/reporter/articles`, { headers: headers(tokens.a) }).then(r => r.json())).articles.length, 1);

  // Ownership: another Reporter cannot reach this article by changing the id.
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.b) })).status, 404);
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) })).status, 200);
  assert.equal((await patch(tokens.b, articleId, full)).status, 404);
  assert.equal((await patch(tokens.a, 'bad-id', full)).status, 404);

  // Unknown body keys are silently ignored, not an error.
  assert.equal((await patch(tokens.a, articleId, { ...full, status: 'published' })).status, 200);
  assert.equal(articles[0].status, 'draft');

  assert.equal((await patch(tokens.a, articleId, { ...full, imageUrl: 'x'.repeat(2049) })).status, 400);
  assert.equal((await patch(tokens.a, articleId, { ...full, imageUrl: {} })).status, 400);

  for (const imageUrl of ['https://', 'unfinished image URL', 'javascript:alert(1)']) {
    assert.equal((await patch(tokens.a, articleId, { ...full, body: 'Keep my latest writing', imageUrl })).status, 200);
    assert.equal(articles[0].draft.body, 'Keep my latest writing');
    assert.equal(articles[0].draft.imageUrl, imageUrl);
    assert.equal(articles[0].published, null);
    const page = await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) }).then(r => r.text());
    assert.ok(page.includes('Keep my latest writing'));
    assert.ok(page.includes(`value="${imageUrl}"`));
  }

  const limits = { title: 200, summary: 500, body: 50000, category: 80, imageUrl: 2048 };
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal((await patch(tokens.a, articleId, { ...full, [field]: '' })).status, 200, `${field} may be empty in a draft`);
    assert.equal((await patch(tokens.a, articleId, { ...full, [field]: 'x'.repeat(limit) })).status, 200, `${field} accepts its limit`);
    assert.equal((await patch(tokens.a, articleId, { ...full, [field]: 'x'.repeat(limit + 1) })).status, 400, `${field} rejects excess length`);
    assert.equal((await patch(tokens.a, articleId, { ...full, [field]: 42 })).status, 400, `${field} must be a string`);
  }

  // A partial patch (missing keys) saves successfully and leaves other fields untouched.
  assert.equal((await patch(tokens.a, articleId, { title: 'Partial only' })).status, 200);
  assert.equal(articles[0].draft.title, 'Partial only');
  assert.equal(articles[0].draft.category, full.category);

  assert.equal((await patch(tokens.a, articleId, full)).status, 200);
  assert.equal(articles[0].draft.title, 'News');

  // Submission: ownership, success, and re-submission while already pending.
  assert.equal((await submit(tokens.b, articleId)).status, 404);
  assert.equal((await submit(tokens.a, articleId)).status, 200);
  assert.equal(articles[0].status, 'pending');
  assert.equal((await patch(tokens.a, articleId, { title: 'Changed while pending' })).status, 409);
  assert.equal(articles[0].draft.title, 'News');
  assert.equal((await submit(tokens.a, articleId)).status, 409);

  const lockedPage = await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) }).then(r => r.text());
  assert.ok(lockedPage.includes('Awaiting review'));

  // A second, still-blank draft cannot be submitted until required fields are complete.
  await fetch(`${base}/reporter/articles`, { method: 'POST', headers: headers(tokens.a) });
  const secondId = articles[1]._id.toString();
  assert.equal((await submit(tokens.a, secondId)).status, 400);

  // Dashboard/JSON listing status filter.
  const draftPage = await fetch(`${base}/reporter?status=draft`, { headers: headers(tokens.a) });
  assert.equal(draftPage.status, 200);
  const draftJson = await fetch(`${base}/reporter/articles?status=draft`, { headers: headers(tokens.a) }).then(r => r.json());
  assert.equal(draftJson.articles.length, 1);
  assert.equal(draftJson.articles[0].id, secondId);
  assert.equal((await fetch(`${base}/reporter?status=bogus`, { headers: headers(tokens.a) })).status, 400);

  // Correction-note display on the dashboard.
  articles[0].editorNote = 'Please add a source.';
  articles[0].status = 'returned';
  const dashboardHtml = await fetch(`${base}/reporter`, { headers: headers(tokens.a) }).then(r => r.text());
  assert.ok(dashboardHtml.includes('Editor note: Please add a source.'));
  assert.ok(dashboardHtml.includes('Edit and resubmit'));
});

