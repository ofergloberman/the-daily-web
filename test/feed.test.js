process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const ViewedArticle = require('../models/ViewedArticle');
const { CARD_FIELDS, encodeCursor, decodeCursor, feedFilter, historyIsSmaller } = require('../models/publicArticleQueries');
const { databaseName, assertDev3Uri } = require('../scripts/dev3Guard');
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
function mockStore(t, docs, calls = [], viewedIds = []) {
  t.mock.method(Article, 'find', filter => {
    const call = { filter };
    calls.push(call);
    return {
      select(fields) { call.select = fields; return this; },
      sort(order) { call.sort = order; return this; },
      limit(count) { call.limit = count; return this; },
      async lean() {
        const keys = Object.entries(call.sort);
        return docs.filter(doc => matches(doc, filter))
          .sort((a, b) => { for (const [k, dir] of keys) { const c = compare(get(a, k), get(b, k)); if (c) return dir * c; } return 0; })
          .slice(0, call.limit).map(doc => ({ ...doc }));
      }
    };
  });
  t.mock.method(Article, 'populate', async (rows, options) => {
    calls.populate = options;
    return rows.map(doc => ({ ...doc, author: { displayName: 'Dana Reporter' } }));
  });
  t.mock.method(Article, 'distinct', async () => [...new Set(docs.map(doc => doc.published.category))]);
  t.mock.method(ViewedArticle, 'find', query => ({ select() { return this; }, async lean() {
    calls.viewedQuery = query;
    const asked = new Set(query.article.$in.map(String));
    return viewedIds.filter(id => asked.has(String(id))).map(article => ({ article }));
  } }));
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
  assert.ok(parseFeedQuery({ sort: ['popular', 'date'] }).fields.sort, 'repeated parameters are rejected, not silently picked');
  assert.ok(parseFeedQuery({ cursor: [dateCursor, dateCursor] }).fields.cursor);
});

test('tampered cursors are rejected, whatever their shape', () => {
  const id = String(new mongoose.Types.ObjectId());
  const raw = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const bad = {
    'fraction views': [raw({ s: 'popular', v: 1.5, id }), 'popular'],
    'string views': [raw({ s: 'popular', v: '7', id }), 'popular'],
    'unsafe integer': [raw({ s: 'popular', v: 2 ** 53, id }), 'popular'],
    'invalid date': [raw({ s: 'date', v: 'not a date', id }), 'date'],
    'bad id': [raw({ s: 'date', v: new Date().toISOString(), id: 'nope' }), 'date'],
    'missing id': [raw({ s: 'date', v: new Date().toISOString() }), 'date'],
    'JSON null': [raw('null'), 'date'],
    'not JSON': [raw('{oops'), 'date']
  };
  for (const [label, [cursor, sort]] of Object.entries(bad)) assert.equal(decodeCursor(cursor, sort), null, label);
  assert.ok(parseFeedQuery({ cursor: 'a'.repeat(201) }).fields.cursor, 'over-long cursors are rejected before decoding');
});

test('scripts and the integration test accept only a _dev3 database, decided from the URI', () => {
  assert.equal(databaseName('mongodb+srv://user:p%40ss@cluster0.example.net/the_daily_web_dev3?retryWrites=true'), 'the_daily_web_dev3');
  assert.equal(databaseName('mongodb://a:1,b:2/team_db'), 'team_db');
  assert.equal(databaseName('mongodb+srv://cluster0.example.net/?retryWrites=true'), '');
  assert.equal(assertDev3Uri('mongodb://localhost/x_dev3'), 'x_dev3');
  assert.throws(() => assertDev3Uri('mongodb+srv://u:p@cluster0.example.net/the_daily_web'), /Refusing/);
  assert.throws(() => assertDev3Uri('mongodb+srv://u:p@cluster0.example.net/?appName=x_dev3'), /Refusing/);
  assert.throws(() => assertDev3Uri(undefined), /Refusing/);
});

test('the unfiltered feed marks exactly the cards this device opened, asking only about the page shown', async t => {
  const docs = makeDocs(25);
  const calls = [];
  const opened = [docs[0]._id, docs[3]._id, docs[24]._id];
  mockStore(t, docs, calls, opened);
  const base = await listen(t);
  const { data } = await (await fetch(`${base}/articles`, { headers: { Cookie: `wd_device=${'c'.repeat(64)}` } })).json();
  const expected = new Set(opened.map(String));
  assert.equal(data.length, FEED_SIZE);
  assert.deepEqual(data.filter(card => card.viewed).map(card => card.id).sort(), data.filter(card => expected.has(card.id)).map(card => card.id).sort());
  assert.ok(data.some(card => card.viewed), 'at least one opened article is on the first page');
  assert.equal(calls.viewedQuery.deviceId, 'c'.repeat(64));
  assert.equal(calls.viewedQuery.article.$in.length, FEED_SIZE, 'only the 20 cards shown, never the whole history');
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
  assert.deepEqual([calls.populate.path, calls.populate.select], ['author', 'displayName']);
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
  let historySize = 30;
  t.mock.method(ViewedArticle, 'countDocuments', async () => historySize);
  const articleCounts = [];
  t.mock.method(Article, 'countDocuments', async filter => { articleCounts.push(filter); return 5000; });
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

  // A device that opened half the site walks the feed instead: 2500^2 > 21 * 5000.
  historySize = 2500;
  await fetch(`${base}/articles?viewed=viewed`, { headers });
  assert.equal(historyPipelines.length, 1, 'no second history pipeline');
  assert.deepEqual(articlePipelines.at(-1)[3].$match, { viewedBy: { $ne: [] } });
  assert.equal(articleCounts[0]['published.category'], 'World', 'the walk is priced on the chosen category');
  assert.ok(!articleCounts[0].$or && !articleCounts[0].$text);
});

test('the history/walk choice switches exactly where records squared passes (limit + 1) * articles', async t => {
  let records;
  t.mock.method(ViewedArticle, 'countDocuments', async () => records);
  t.mock.method(Article, 'countDocuments', async () => 5000);
  // 21 * 5000 = 105000; 324^2 = 104976 <= 105000 < 325^2 = 105625.
  for (const [count, expected] of [[0, true], [324, true], [325, false], [2500, false]]) {
    records = count;
    assert.equal(await historyIsSmaller('d'.repeat(64), FEED_SIZE), expected, `${count} records`);
  }
});
