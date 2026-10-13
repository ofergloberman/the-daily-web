process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const ViewedArticle = require('../models/ViewedArticle');
const { CARD_FIELDS, encodeCursor, decodeCursor, feedFilter } = require('../models/publicArticleQueries');
const { FEED_SIZE, parseFeedQuery } = require('../controllers/publicArticleController');

// Small in-memory evaluator for exactly the filter shapes feedFilter builds (keyset $or, category, published).
function compare(a, b) {
  if (a instanceof mongoose.Types.ObjectId) return String(a).localeCompare(String(b));
  if (a instanceof Date) return a.getTime() - new Date(b).getTime();
  return a - b;
}
function get(doc, path) { return path.split('.').reduce((value, key) => value?.[key], doc); }
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some(part => matches(doc, part));
    if (key === '$text') return get(doc, 'published.title').toLowerCase().includes(cond.$search.toLowerCase());
    const value = get(doc, key);
    if (cond && typeof cond === 'object' && '$ne' in cond) return value !== cond.$ne && value !== undefined;
    if (cond && typeof cond === 'object' && '$lt' in cond) return compare(value, cond.$lt) < 0;
    return compare(value, cond) === 0 || value === cond;
  });
}
function mockStore(t, docs, calls = []) {
  t.mock.method(Article, 'find', filter => {
    const call = { filter };
    calls.push(call);
    return {
      select(fields) { call.select = fields; return this; },
      sort(order) { call.sort = order; return this; },
      limit(count) { call.limit = count; return this; },
      populate(path, fields) { call.populate = [path, fields]; return this; },
      async lean() {
        const keys = Object.entries(call.sort);
        return docs.filter(doc => matches(doc, filter))
          .sort((a, b) => { for (const [k, dir] of keys) { const c = compare(get(a, k), get(b, k)); if (c) return dir * c; } return 0; })
          .slice(0, call.limit).map(doc => ({ ...doc, author: { displayName: 'Dana Reporter' } }));
      }
    };
  });
  t.mock.method(Article, 'distinct', async () => [...new Set(docs.map(doc => doc.published.category))]);
  t.mock.method(ViewedArticle, 'find', () => ({ select() { return this; }, async lean() { return []; } }));
}
function makeDocs(count) {
  const base = Date.parse('2026-09-01T12:00:00Z');
  return Array.from({ length: count }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(), totalViews: i % 4, // many popularity ties
    publishedAt: new Date(base + Math.floor(i / 3) * 3600e3), // three articles share each timestamp
    published: { title: `Story ${i} ${i % 2 ? 'election' : 'weather'}`, summary: 'S', body: 'SECRET BODY', category: i % 3 ? 'World' : 'Tech', imageUrl: '' },
    draft: { title: 'DRAFT TITLE' }, editorNote: 'EDITOR NOTE'
  }));
}
async function listen(t) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('parseFeedQuery accepts defaults and rejects bad input with field errors', () => {
  assert.deepEqual(parseFeedQuery({}).value, { q: '', category: '', sort: 'date', viewed: 'all', after: null });
  assert.deepEqual(parseFeedQuery({ q: '  vote ', category: ' World ', sort: 'popular', viewed: 'unviewed' }).value, { q: 'vote', category: 'World', sort: 'popular', viewed: 'unviewed', after: null });
  assert.ok(parseFeedQuery({ viewed: 'maybe' }).fields.viewed);
  assert.ok(parseFeedQuery({ viewed: ['viewed', 'all'] }).fields.viewed);
  assert.ok(parseFeedQuery({ sort: 'random' }).fields.sort);
  assert.ok(parseFeedQuery({ q: 'x'.repeat(101) }).fields.q);
  assert.ok(parseFeedQuery({ q: ['a', 'b'] }).fields.q);
  assert.ok(parseFeedQuery({ category: ['a', 'b'] }).fields.category);
  assert.ok(parseFeedQuery({ cursor: 'garbage' }).fields.cursor);
  const dateCursor = encodeCursor('date', { _id: new mongoose.Types.ObjectId(), publishedAt: new Date() });
  assert.ok(parseFeedQuery({ sort: 'popular', cursor: dateCursor }).fields.cursor, 'a cursor only works with the sort that made it');
  assert.ok(parseFeedQuery({ cursor: dateCursor }).value.after);
});

test('cursors round-trip and build a keyset filter with an _id tie-breaker', () => {
  const id = new mongoose.Types.ObjectId();
  const date = decodeCursor(encodeCursor('date', { _id: id, publishedAt: new Date('2026-10-01T00:00:00Z') }), 'date');
  assert.equal(date.value.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.ok(date.id.equals(id));
  const popular = decodeCursor(encodeCursor('popular', { _id: id, totalViews: 7 }), 'popular');
  assert.equal(popular.value, 7);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ s: 'popular', v: -1, id: String(id) })).toString('base64url'), 'popular'), null);
  assert.deepEqual(feedFilter({ q: 'vote', category: 'World', sort: 'popular', after: popular }), {
    published: { $ne: null }, publishedAt: { $ne: null }, $text: { $search: 'vote' }, 'published.category': 'World',
    $or: [{ totalViews: { $lt: 7 } }, { totalViews: 7, _id: { $lt: popular.id } }]
  });
});

test('GET /articles walks every article exactly once, in order, for both sorts', async t => {
  const docs = makeDocs(45);
  const calls = [];
  mockStore(t, docs, calls);
  const base = await listen(t);
  for (const sort of ['date', 'popular']) {
    const ids = [];
    let cursor = '', pages = 0;
    do {
      const response = await fetch(`${base}/articles?sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(response.status, 200);
      const { data, pagination } = await response.json();
      pages++;
      assert.ok(data.length <= FEED_SIZE);
      ids.push(...data.map(article => article.id));
      assert.equal(pagination.hasMore, pagination.nextCursor !== null);
      cursor = pagination.nextCursor;
    } while (cursor);
    assert.equal(pages, 3, `${sort}: 20 + 20 + 5`);
    assert.equal(new Set(ids).size, 45, `${sort}: no duplicates or gaps`);
    const field = sort === 'date' ? 'publishedAt' : 'totalViews';
    const expected = [...docs].sort((a, b) => compare(b[field], a[field]) || compare(b._id, a._id)).map(doc => String(doc._id));
    assert.deepEqual(ids, expected);
  }
  assert.ok(calls.every(call => call.limit === FEED_SIZE + 1 && call.select === CARD_FIELDS));
  assert.deepEqual(calls[0].populate, ['author', 'displayName']);
  assert.deepEqual(calls[0].sort, { publishedAt: -1, _id: -1 });
});

test('GET /articles returns only card fields and combines search with category', async t => {
  const calls = [];
  mockStore(t, makeDocs(12), calls);
  const base = await listen(t);
  const response = await fetch(`${base}/articles?q=election&category=World`);
  const text = await response.text();
  assert.doesNotMatch(text, /SECRET BODY|DRAFT TITLE|EDITOR NOTE/);
  const { data, pagination } = JSON.parse(text);
  assert.deepEqual(pagination, { nextCursor: null, hasMore: false });
  assert.ok(data.length > 0);
  for (const article of data) {
    assert.deepEqual(Object.keys(article).sort(), ['author', 'category', 'id', 'imageUrl', 'publishedAt', 'summary', 'title', 'viewed']);
    assert.equal(article.category, 'World');
    assert.match(article.title, /election/);
    assert.match(article.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.deepEqual(calls[0].filter.$text, { $search: 'election' });
  assert.doesNotMatch(CARD_FIELDS, /draft|editorNote|body/);

  const bad = await fetch(`${base}/articles?sort=random&cursor=x`);
  assert.equal(bad.status, 400);
  const error = await bad.json();
  assert.equal(error.error, 'INVALID_FEED_QUERY');
  assert.ok(error.message && error.fields.sort);
});

test('homepage renders filters, categories and a no-JS "More articles" link', async t => {
  mockStore(t, makeDocs(40));
  const base = await listen(t);
  const html = await (await fetch(`${base}/?category=World&sort=popular`)).text();
  assert.match(html, /<option value="World" selected>World<\/option>/);
  assert.match(html, /<option value="Tech">Tech<\/option>/);
  assert.match(html, /<option value="popular" selected>Most popular<\/option>/);
  assert.equal((html.match(/class="article-card"/g) || []).length, FEED_SIZE);
  const cursor = html.match(/data-next-cursor="([^"]+)"/)[1];
  assert.ok(decodeCursor(cursor, 'popular'));
  assert.match(html, new RegExp(`href="/\\?q=&amp;category=World&amp;sort=popular&amp;viewed=all&amp;cursor=${cursor}">More articles`));
  assert.match(html, /<script src="\/feed.js" defer><\/script>/);

  const next = await (await fetch(`${base}/?category=World&sort=popular&cursor=${cursor}`)).text();
  assert.equal((next.match(/class="article-card"/g) || []).length, makeDocs(40).filter(d => d.published.category === 'World').length - FEED_SIZE);
  assert.doesNotMatch(next, /More articles/);

  const none = await fetch(`${base}/?q=nothing-matches`);
  assert.equal(none.status, 200);
  assert.match(await none.text(), /No matching articles/);
  assert.equal((await fetch(`${base}/?sort=random`)).status, 200, 'bad values fall back to the default feed');
});

test('viewed filters join on this device inside MongoDB, after sorting and before the limit', async t => {
  const { viewedPipeline, deviceHistoryPipeline } = require('../models/publicArticleQueries');
  const filter = { published: { $ne: null } };
  const pipeline = viewedPipeline({ filter, sort: 'popular', viewed: 'unviewed', deviceId: 'd'.repeat(64), limit: 20 });
  assert.deepEqual(pipeline.map(stage => Object.keys(stage)[0]), ['$match', '$sort', '$lookup', '$match', '$limit', '$project']);
  assert.equal(pipeline[0].$match, filter, 'search/keyset filter stays the first stage ($text must be first)');
  assert.deepEqual(pipeline[1].$sort, { totalViews: -1, _id: -1 });
  assert.deepEqual(pipeline[2].$lookup, { from: 'viewedarticles', localField: '_id', foreignField: 'article', pipeline: [{ $match: { deviceId: 'd'.repeat(64) } }, { $project: { _id: 1 } }], as: 'viewedBy' });
  assert.deepEqual(pipeline[3].$match, { viewedBy: { $eq: [] } });
  assert.deepEqual(viewedPipeline({ filter, sort: 'date', viewed: 'viewed', deviceId: 'x', limit: 20 })[3].$match, { viewedBy: { $ne: [] } });
  assert.equal(pipeline[4].$limit, FEED_SIZE + 1);
  assert.ok(!('draft' in pipeline[5].$project) && !('editorNote' in pipeline[5].$project) && !('published.body' in pipeline[5].$project));

  const history = deviceHistoryPipeline({ filter, sort: 'date', deviceId: 'd'.repeat(64), limit: 20 });
  assert.deepEqual(history[0], { $match: { deviceId: 'd'.repeat(64) } }, '"viewed" starts from the device history');
  assert.equal(history[1].$lookup.pipeline[0].$match, filter);
  assert.deepEqual(history.slice(-2), [{ $sort: { publishedAt: -1, _id: -1 } }, { $limit: FEED_SIZE + 1 }]);

  const articlePipelines = [], historyPipelines = [];
  const doc = { _id: new mongoose.Types.ObjectId(), publishedAt: new Date(), totalViews: 0, published: { title: 'Seen before', category: 'World' } };
  t.mock.method(Article, 'aggregate', async stages => { articlePipelines.push(stages); return [doc]; });
  t.mock.method(ViewedArticle, 'aggregate', async stages => { historyPipelines.push(stages); return [doc]; });
  t.mock.method(Article, 'populate', async docs => docs.map(d => ({ ...d, author: { displayName: 'Dana' } })));
  const base = await listen(t);
  const device = 'e'.repeat(64);
  const headers = { Cookie: `wd_device=${device}` };
  const response = await fetch(`${base}/articles?viewed=viewed&category=World`, { headers });
  assert.equal(response.headers.get('cache-control'), 'private, no-cache', 'per-device results must not be shared by caches');
  const { data } = await response.json();
  assert.equal(historyPipelines[0][0].$match.deviceId, device, 'the cookie device, never one from the query string');
  assert.equal(historyPipelines[0][1].$lookup.pipeline[0].$match['published.category'], 'World');
  assert.deepEqual(data.map(article => [article.title, article.viewed]), [['Seen before', true]]);

  await fetch(`${base}/articles?viewed=unviewed&category=World&sort=popular`, { headers });
  await fetch(`${base}/articles?viewed=viewed&q=vote`, { headers });
  assert.deepEqual(articlePipelines.map(p => p[3].$match), [{ viewedBy: { $eq: [] } }, { viewedBy: { $ne: [] } }], 'unviewed, and viewed+search, walk the articles');
  assert.equal(articlePipelines[0][2].$lookup.pipeline[0].$match.deviceId, device);
  assert.equal(articlePipelines[0][0].$match['published.category'], 'World');
  assert.deepEqual(articlePipelines[1][0].$match.$text, { $search: 'vote' });
  assert.equal((await fetch(`${base}/articles?viewed=sometimes`)).status, 400);
});
