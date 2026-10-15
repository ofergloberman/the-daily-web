// Opt-in check of the feed queries against real MongoDB (text index semantics, keyset paging).
// Run: FEED_INTEGRATION=1 node --env-file=.env --test test/feed.integration.test.js
// Only touches a database whose name ends in _dev3, and only articles it creates itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const ViewedArticle = require('../models/ViewedArticle');
const { findFeed, decodeCursor } = require('../models/publicArticleQueries');
const { assertDev3Uri } = require('../scripts/dev3Guard');

const enabled = process.env.FEED_INTEGRATION === '1' && Boolean(process.env.MONGODB_URI);

test('feed queries page correctly on real MongoDB', { skip: !enabled && 'set FEED_INTEGRATION=1 and MONGODB_URI' }, async t => {
  assertDev3Uri(process.env.MONGODB_URI); // Before connecting, which already creates collections and indexes.
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await Article.init(); // Make sure the text and feed indexes exist.

  const category = `it-${randomBytes(4).toString('hex')}`;
  const author = new mongoose.Types.ObjectId();
  const base = Date.parse('2026-09-01T12:00:00Z');
  const words = ['election', 'elections', 'selection', 'budget'];
  const docs = Array.from({ length: 45 }, (_, i) => {
    const content = { title: `Integration ${words[i % words.length]} story ${i}`, summary: 'S', body: 'B', category };
    return { author, draft: content, published: content, status: 'published', totalViews: i % 4, publishedAt: new Date(base + Math.floor(i / 3) * 3600e3) };
  });
  const inserted = await Article.insertMany(docs);
  const devices = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  t.after(async () => {
    await ViewedArticle.deleteMany({ deviceId: { $in: devices } });
    await Article.deleteMany({ 'published.category': category });
    await mongoose.disconnect();
  });

  async function walk(filters) {
    const ids = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const result = await findFeed({ category, after, limit: 20, ...filters });
      ids.push(...result.articles.map(a => String(a._id)));
      if (!result.hasMore) break;
      after = decodeCursor(result.nextCursor, filters.sort); // Same cursor round-trip the API uses.
    }
    return ids;
  }

  for (const sort of ['date', 'popular']) {
    const field = sort === 'date' ? 'publishedAt' : 'totalViews';
    const expected = [...inserted].sort((a, b) => (b[field] - a[field]) || String(b._id).localeCompare(String(a._id))).map(a => String(a._id));
    assert.deepEqual(await walk({ sort }), expected, `${sort}: every article once, in keyset order`);
  }

  // Real text search is word-based with stemming: "election" matches "elections" but not "selection".
  const found = await walk({ sort: 'date', q: 'election' });
  const titles = inserted.filter(a => found.includes(String(a._id))).map(a => a.published.title);
  assert.ok(titles.length > 20, 'search results span more than one page');
  assert.ok(titles.every(title => /\belections?\b/.test(title)));
  assert.ok(titles.some(title => /\belections\b/.test(title)));
  assert.equal(new Set(found).size, found.length);
  // Viewed / not viewed: device A opened every third article (some twice); device B opened none.
  await ViewedArticle.init();
  const opened = inserted.filter((_, i) => i % 3 === 0);
  for (const article of [...opened, ...opened.slice(0, 5)]) await ViewedArticle.markViewed(devices[0], article._id);
  await Promise.all(opened.slice(0, 3).map(article => ViewedArticle.markViewed(devices[0], article._id))); // concurrent repeats
  assert.equal(await ViewedArticle.countDocuments({ deviceId: devices[0] }), opened.length, 'repeat visits never duplicate membership');

  const openedIds = new Set(opened.map(a => String(a._id)));
  for (const sort of ['date', 'popular']) {
    const viewed = await walk({ sort, viewed: 'viewed', deviceId: devices[0] });
    const unviewed = await walk({ sort, viewed: 'unviewed', deviceId: devices[0] });
    const all = await walk({ sort, deviceId: devices[0] });
    assert.deepEqual(new Set(viewed), openedIds, `${sort}: viewed = exactly the opened articles`);
    assert.equal(unviewed.length, 45 - opened.length, `${sort}: unviewed pages past 20 without gaps`);
    assert.ok(unviewed.every(id => !openedIds.has(id)));
    assert.deepEqual([...viewed, ...unviewed].sort(), [...all].sort());
    assert.deepEqual(all.filter(id => openedIds.has(id)), viewed, `${sort}: same order as the unfiltered feed`);
  }
  const page = await findFeed({ category, deviceId: devices[0], limit: 20 });
  assert.ok(page.articles.every(a => a.viewed === openedIds.has(String(a._id))), 'cards carry the viewed flag');
  assert.ok(page.articles.every(a => typeof a.author?.displayName === 'string' || a.author === null));

  // Combined with search, and separate devices have separate histories.
  const viewedElection = await walk({ sort: 'date', q: 'election', viewed: 'viewed', deviceId: devices[0] });
  assert.ok(viewedElection.length > 0 && viewedElection.every(id => openedIds.has(id)));
  assert.deepEqual(await walk({ sort: 'date', viewed: 'viewed', deviceId: devices[1] }), []);
  assert.equal((await walk({ sort: 'date', viewed: 'unviewed', deviceId: devices[1] })).length, 45);
});
