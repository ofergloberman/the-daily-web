const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');

// Generic in-memory filter matcher supporting the shapes articleWorkflow.js
// issues: exact field equality (including ObjectId/string coercion),
// `{ $ne: value }` for the pending-lock guard, and `$or`/`{ $exists }` for
// the legacy-document draftVersion fallback in saveDraftContent.
function matches(doc, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or') {
      if (!value.some(sub => matches(doc, sub))) return false;
      continue;
    }
    const actual = key === '_id' ? String(doc._id) : key === 'author' ? String(doc.author) : doc[key];
    if (value && typeof value === 'object' && '$ne' in value) {
      if (String(actual) === String(value.$ne)) return false;
    } else if (value && typeof value === 'object' && '$exists' in value) {
      const present = actual !== undefined;
      if (present !== value.$exists) return false;
    } else if (String(actual) !== String(value)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) {
      if (path.includes('.')) {
        const [root, sub] = path.split('.');
        doc[root][sub] = value;
      } else {
        doc[path] = value;
      }
    }
  }
  if (update.$inc) {
    for (const [path, amount] of Object.entries(update.$inc)) doc[path] = (doc[path] || 0) + amount;
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
  const submit = (token, id, baseVersion) => fetch(`${base}/reporter/articles/${id}/submit`, {
    method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: baseVersion ?? draftVersion })
  });

  // Every saveDraftContent write bumps the article's draftVersion by one; the
  // client must echo back the version it last saw as `baseVersion`. Track it
  // locally so each call below can supply the correct one.
  let draftVersion = 0;
  const withVersion = body => ({ ...body, baseVersion: draftVersion });

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
  assert.equal((await patch(tokens.b, articleId, withVersion(full))).status, 404);
  assert.equal((await patch(tokens.a, 'bad-id', withVersion(full))).status, 404);

  // A missing/invalid baseVersion is rejected before any ownership or content check.
  assert.equal((await patch(tokens.a, articleId, full)).status, 400);

  // Unknown body keys are silently ignored, not an error.
  assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, status: 'published' }))).status, 200);
  draftVersion += 1;
  assert.equal(articles[0].status, 'draft');

  assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, imageUrl: 'x'.repeat(2049) }))).status, 400);
  assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, imageUrl: {} }))).status, 400);

  for (const imageUrl of ['https://', 'unfinished image URL', 'javascript:alert(1)']) {
    assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, body: 'Keep my latest writing', imageUrl }))).status, 200);
    draftVersion += 1;
    assert.equal(articles[0].draft.body, 'Keep my latest writing');
    assert.equal(articles[0].draft.imageUrl, imageUrl);
    assert.equal(articles[0].published, null);
    const page = await fetch(`${base}/reporter/articles/${articleId}/edit`, { headers: headers(tokens.a) }).then(r => r.text());
    assert.ok(page.includes('Keep my latest writing'));
    assert.ok(page.includes(`value="${imageUrl}"`));
  }

  const limits = { title: 200, summary: 500, body: 50000, category: 80, imageUrl: 2048 };
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, [field]: '' }))).status, 200, `${field} may be empty in a draft`);
    draftVersion += 1;
    assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, [field]: 'x'.repeat(limit) }))).status, 200, `${field} accepts its limit`);
    draftVersion += 1;
    assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, [field]: 'x'.repeat(limit + 1) }))).status, 400, `${field} rejects excess length`);
    assert.equal((await patch(tokens.a, articleId, withVersion({ ...full, [field]: 42 }))).status, 400, `${field} must be a string`);
  }

  // A partial patch (missing keys) saves successfully and leaves other fields untouched.
  assert.equal((await patch(tokens.a, articleId, withVersion({ title: 'Partial only' }))).status, 200);
  draftVersion += 1;
  assert.equal(articles[0].draft.title, 'Partial only');
  assert.equal(articles[0].draft.category, full.category);

  assert.equal((await patch(tokens.a, articleId, withVersion(full))).status, 200);
  draftVersion += 1;
  assert.equal(articles[0].draft.title, 'News');

  // A stale/delayed request (old baseVersion) cannot overwrite a newer save -
  // requests cannot clobber each other out of order.
  const staleResponse = await patch(tokens.a, articleId, { ...full, title: 'Clobber attempt', baseVersion: draftVersion - 1 });
  assert.equal(staleResponse.status, 409);
  const staleBody = await staleResponse.json();
  assert.equal(staleBody.error, 'STALE_DRAFT');
  assert.equal(staleBody.latest.draftVersion, draftVersion);
  assert.equal(staleBody.latest.draft.title, 'News');
  assert.equal(articles[0].draft.title, 'News');

  // A non-http(s)/unfinished imageUrl blocks submission even though every
  // required field is complete - draft saving deliberately allows it, but it
  // must never be possible to submit (and later publish) a bad image URL.
  for (const imageUrl of ['javascript:alert(1)', 'https://', 'unfinished image URL']) {
    assert.equal((await patch(tokens.a, articleId, withVersion({ imageUrl }))).status, 200);
    draftVersion += 1;
    assert.equal((await submit(tokens.a, articleId)).status, 400);
    assert.equal(articles[0].status, 'draft');
  }
  assert.equal((await patch(tokens.a, articleId, withVersion({ imageUrl: full.imageUrl }))).status, 200);
  draftVersion += 1;

  // A missing/invalid baseVersion is rejected before any ownership or state check.
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/submit`, {
    method: 'POST', headers: { ...headers(tokens.a), 'Content-Type': 'application/json' }, body: JSON.stringify({})
  })).status, 400);
  // A submission request sent with no body at all must not crash the server.
  assert.equal((await fetch(`${base}/reporter/articles/${articleId}/submit`, { method: 'POST', headers: headers(tokens.a) })).status, 400);

  // A stale baseVersion at submission time is rejected as a conflict rather
  // than silently approving content the client never actually saw (e.g. if
  // another session changed it between this tab's last read and submit).
  const staleSubmit = await submit(tokens.a, articleId, draftVersion - 1);
  assert.equal(staleSubmit.status, 409);
  const staleSubmitBody = await staleSubmit.json();
  assert.equal(staleSubmitBody.error, 'STALE_DRAFT');
  assert.equal(staleSubmitBody.latest.draftVersion, draftVersion);
  assert.equal(articles[0].status, 'draft');

  // Submission: ownership, success, and re-submission while already pending.
  assert.equal((await submit(tokens.b, articleId)).status, 404);
  assert.equal((await submit(tokens.a, articleId)).status, 200);
  assert.equal(articles[0].status, 'pending');
  assert.equal((await patch(tokens.a, articleId, withVersion({ title: 'Changed while pending' }))).status, 409);
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

  // The status filter tabs must stay visible (so the reporter can navigate
  // back to "All") even when the chosen filter has zero matching articles,
  // and the active tab must be exposed to assistive tech via aria-current.
  const publishedPage = await fetch(`${base}/reporter?status=published`, { headers: headers(tokens.a) }).then(r => r.text());
  assert.ok(publishedPage.includes('No articles yet'));
  assert.ok(publishedPage.includes('status-tabs'));
  assert.ok(publishedPage.includes('href="/reporter">All</a>'));
  assert.match(publishedPage, /class="active" aria-current="page" href="\/reporter\?status=published"/);

  // Correction-note display on the dashboard.
  articles[0].editorNote = 'Please add a source.';
  articles[0].status = 'returned';
  const dashboardHtml = await fetch(`${base}/reporter`, { headers: headers(tokens.a) }).then(r => r.text());
  assert.ok(dashboardHtml.includes('Editor note: Please add a source.'));
  assert.ok(dashboardHtml.includes('Edit and resubmit'));
});

