// Run as if hosted in UTC so a missing site timezone shows up on any developer machine.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const { PUBLIC_FIELDS, CARD_FIELDS } = require('../models/publicArticleQueries');
const { FEED_SIZE, paragraphs } = require('../controllers/publicArticleController');
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

  assert.equal((await fetch(`${base}/articles/${draftOnly._id}`)).status, 404);
  assert.equal((await fetch(`${base}/articles/${new mongoose.Types.ObjectId()}`)).status, 404);
  const invalid = await fetch(`${base}/articles/not-an-id`);
  assert.equal(invalid.status, 404);
  assert.match(await invalid.text(), /Article not found/);
});

test('article body splits into trimmed non-empty paragraphs', () => {
  assert.deepEqual(paragraphs(' One \r\n\r\nTwo\n  \nThree'), ['One', 'Two', 'Three']);
  assert.deepEqual(paragraphs(undefined), []);
});

test('homepage lists the latest published cards without draft fields', async t => {
  const calls = {};
  const card = {
    _id: new mongoose.Types.ObjectId(), author: { displayName: 'Dana Reporter' }, publishedAt: new Date('2026-10-02T22:00:00Z'),
    published: { title: 'Newest approved story', summary: 'Card summary', category: 'Tech', imageUrl: '' }
  };
  t.mock.method(Article, 'find', query => {
    calls.query = query;
    return {
      select(fields) { calls.select = fields; return this; },
      sort(order) { calls.sort = order; return this; },
      limit(count) { calls.limit = count; return this; },
      populate(path, fields) { calls.populate = [path, fields]; return this; },
      async lean() { return [card]; }
    };
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();

  assert.deepEqual(calls.query, { published: { $ne: null } });
  assert.deepEqual(calls.sort, { publishedAt: -1, _id: -1 });
  assert.equal(calls.limit, FEED_SIZE);
  assert.deepEqual(calls.populate, ['author', 'displayName']);
  assert.equal(calls.select, CARD_FIELDS);
  assert.doesNotMatch(CARD_FIELDS, /draft|editorNote|body/);
  assert.match(html, new RegExp(`<a href="/articles/${card._id}">Newest approved story</a>`));
  assert.match(html, /Card summary/);
  assert.match(html, /datetime="2026-10-02T22:00:00.000Z">Oct 3, 2026</);
  assert.doesNotMatch(html, /No articles yet/);
});

test('a failing recordVisit never breaks the article page', async t => {
  const article = { _id: new mongoose.Types.ObjectId(), author: { displayName: 'Dana' }, published: { title: 'Still readable', body: 'Body.' } };
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
