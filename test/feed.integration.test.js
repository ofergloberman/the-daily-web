// Opt-in check of the feed queries against real MongoDB (text index semantics, keyset paging).
// Run: FEED_INTEGRATION=1 node --env-file=.env --test test/feed.integration.test.js
// Only touches a database whose name ends in _dev3, and only articles it creates itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const { findFeed, decodeCursor } = require('../models/publicArticleQueries');

const enabled = process.env.FEED_INTEGRATION === '1' && Boolean(process.env.MONGODB_URI);

test('feed queries page correctly on real MongoDB', { skip: !enabled && 'set FEED_INTEGRATION=1 and MONGODB_URI' }, async t => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  assert.ok(mongoose.connection.name.endsWith('_dev3'), `refusing to write to ${mongoose.connection.name}`);
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
  t.after(async () => { await Article.deleteMany({ 'published.category': category }); await mongoose.disconnect(); });

  async function walk(filters) {
    const ids = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const result = await findFeed({ ...filters, category, after, limit: 20 });
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
});
