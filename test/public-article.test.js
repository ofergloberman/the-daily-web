// Run as if hosted in UTC so a missing site timezone shows up on any developer machine.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const ViewedArticle = require('../models/ViewedArticle');
const { PUBLIC_FIELDS } = require('../models/publicArticleQueries');
const { paragraphs } = require('../controllers/publicArticleController');
const visits = require('../services/visits');

test('public article page renders only the published snapshot', async t => {
  const author = { _id: new mongoose.Types.ObjectId(), displayName: 'Dana Reporter' };
  const live = new Article({
    author: author._id, status: 'pending', editorNote: 'Secret editor note',
    published: { title: 'Approved headline', summary: 'Approved summary', body: 'First paragraph.\n\nSecond <b>paragraph</b>.', category: 'World' },
    draft: { title: 'Unapproved draft headline', body: 'Draft body text' },
    publishedAt: new Date('2026-10-01T22:30:00Z')
  });
  const draftOnly = new Article({ author: author._id, draft: { title: 'Never published' } });
  const stored = [live, draftOnly];
  const selections = [];
  let rows = [{ _id: new mongoose.Types.ObjectId(), article: live._id,
    displayName: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>',
    createdAt: new Date('2026-10-02T12:00:00Z') }];
  const commentQuery = t.mock.method(Comment, 'find', query => {
    assert.equal(String(query.article), String(live._id));
    return {
      select(fields) { assert.equal(fields, 'article displayName body createdAt'); return this; },
      sort(order) { assert.deepEqual(order, { createdAt: 1, _id: 1 }); return this; },
      async lean() { return rows; }
    };
  });

  t.mock.method(ViewedArticle, 'markViewed', async () => {});
  t.mock.method(visits, 'recordVisit', async () => {}); // D4 analytics would otherwise wait for a database.
  t.mock.method(Article, 'findOne', query => {
    let selected;
    return {
      select(fields) { selected = fields; selections.push(fields); return this; },
      populate() { return this; },
      async lean() {
        const found = stored.find(a => String(a._id) === query._id && (query.published?.$ne === null ? a.published : true));
        if (!found) return null;
        const doc = found.toObject();
        const projected = { _id: doc._id };
        for (const field of selected.split(' ')) projected[field] = doc[field];
        projected.author = author;
        return projected;
      }
    };
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${base}/articles/${live._id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Approved headline<\/h1>/);
  assert.match(html, /<p>First paragraph\.<\/p>/);
  assert.match(html, /Second &lt;b&gt;paragraph&lt;\/b&gt;\./);
  assert.match(html, /Dana Reporter/);
  assert.match(html, /datetime="2026-10-01T22:30:00.000Z">October 2, 2026</);
  assert.doesNotMatch(html, /Unapproved draft headline|Draft body text|Secret editor note/);
  assert.ok(selections.every(fields => fields === PUBLIC_FIELDS));
  assert.doesNotMatch(PUBLIC_FIELDS, /draft|editorNote/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.match(html, /data-comments-empty hidden/);
  assert.match(html, /class="comment-form" action="\/comments"/);
  assert.match(html, /href="\/article-comments.css"/);
  assert.match(html, /src="\/article-comments.js" defer/);
  rows = [];
  const emptyHtml = await (await fetch(`${base}/articles/${live._id}`)).text();
  assert.match(emptyHtml, /data-comments-empty>No comments yet/);
  assert.match(emptyHtml, /name="body"/);

  assert.equal((await fetch(`${base}/articles/${draftOnly._id}`)).status, 404);
  assert.equal((await fetch(`${base}/articles/${new mongoose.Types.ObjectId()}`)).status, 404);
  const invalid = await fetch(`${base}/articles/not-an-id`);
  assert.equal(invalid.status, 404);
  assert.match(await invalid.text(), /Article not found/);
  assert.equal(commentQuery.mock.callCount(), 2, 'private and invalid articles must not query comments');
});

test('a visit is recorded against the publication the page served', async t => {
  t.mock.method(Comment, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return []; } }));
  const article = {
    _id: new mongoose.Types.ObjectId(), currentPublication: new mongoose.Types.ObjectId(),
    author: { displayName: 'Dana' }, published: { title: 'Counted', body: 'Body.' }
  };
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, populate() { return this; }, async lean() { return article; } }));
  const record = t.mock.method(visits, 'recordVisit', async () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/articles/${article._id}`)).status, 200);
  assert.equal(record.mock.callCount(), 1);
  assert.equal(record.mock.calls[0].arguments[0].currentPublication, article.currentPublication);
  assert.match(PUBLIC_FIELDS, /\bcurrentPublication\b/);
});

test('article body splits into trimmed non-empty paragraphs', () => {
  assert.deepEqual(paragraphs(' One \r\n\r\nTwo\n  \nThree'), ['One', 'Two', 'Three']);
  assert.deepEqual(paragraphs(undefined), []);
});

test('a failing recordVisit never breaks the article page', async t => {
  t.mock.method(Comment, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return []; } }));
  const article = { _id: new mongoose.Types.ObjectId(), author: { displayName: 'Dana' }, published: { title: 'Still readable', body: 'Body.' } };
  t.mock.method(ViewedArticle, 'markViewed', async () => {});
  t.mock.method(visits, 'recordVisit', async () => {}); // D4 analytics would otherwise wait for a database.
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, populate() { return this; }, async lean() { return article; } }));
  t.mock.method(console, 'error', () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/articles/${article._id}`;

  t.mock.method(visits, 'recordVisit', () => { throw new Error('sync failure'); });
  assert.equal((await fetch(url)).status, 200);
  visits.recordVisit.mock.restore();
  t.mock.method(visits, 'recordVisit', async () => { throw new Error('async failure'); });
  assert.equal((await fetch(url)).status, 200);
});

test('comment database errors reach the request error handler', async t => {
  const article = { _id: new mongoose.Types.ObjectId(), published: { title: 'Public', body: 'Body' } };
  t.mock.method(ViewedArticle, 'markViewed', async () => {});
  t.mock.method(visits, 'recordVisit', async () => {}); // D4 analytics would otherwise wait for a database.
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, populate() { return this; }, async lean() { return article; } }));
  t.mock.method(Comment, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { throw new Error('private database details'); } }));
  t.mock.method(console, 'error', () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/articles/${article._id}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'INTERNAL_SERVER_ERROR' });
});

test('opening an article marks it viewed for this device only, and a failure never breaks the page', async t => {
  const article = { _id: new mongoose.Types.ObjectId(), author: { displayName: 'Dana' }, published: { title: 'Viewed story', body: 'Body.' } };
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, populate() { return this; }, async lean() { return article; } }));
  t.mock.method(Comment, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return []; } }));
  t.mock.method(console, 'error', () => {});
  const visitsRecorded = [];
  t.mock.method(visits, 'recordVisit', async visited => { visitsRecorded.push(String(visited._id)); });
  const marks = [];
  t.mock.method(ViewedArticle, 'markViewed', async (deviceId, articleId) => { marks.push([deviceId, String(articleId)]); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/articles/${article._id}`;
  const device = 'd'.repeat(64);

  assert.equal((await fetch(url, { headers: { Cookie: `wd_device=${device}` } })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(marks, [[device, String(article._id)]]);
  await fetch(url, { headers: { Cookie: `wd_device=${device}` } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visitsRecorded.length, 2, 'every visit still counts in D4 analytics');
  assert.equal(marks.length, 2, 'each visit with a cookie asks to mark; the upsert makes repeats harmless');

  const cookieless = await fetch(url);
  assert.equal(cookieless.status, 200);
  assert.match(cookieless.headers.get('set-cookie'), /^wd_device=/);
  assert.equal((await fetch(url, { method: 'HEAD', headers: { Cookie: `wd_device=${device}` } })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(marks.length, 2, 'no record for a cookieless client (new random id each time) or a HEAD request');
  assert.equal(visitsRecorded.length, 4, 'analytics counting is unchanged for those requests');

  ViewedArticle.markViewed.mock.restore();
  t.mock.method(ViewedArticle, 'markViewed', async () => { throw new Error('db down'); });
  assert.equal((await fetch(url, { headers: { Cookie: `wd_device=${device}` } })).status, 200);
});
