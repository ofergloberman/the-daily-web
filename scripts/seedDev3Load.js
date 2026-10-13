// Large D3 dataset for checking feed performance: N published articles (default 5000) spread over a year,
// with many popularity ties, plus viewed history for two named devices and 500 random ones.
// Runs only against a database whose name ends in _dev3, and replaces only its own earlier load data.
// Usage: npm run seed:dev3:load [-- 5000]
const mongoose = require('mongoose');
const { createHash, randomBytes } = require('node:crypto');
const { connectDatabase } = require('../config/database');
const { ROLES, ARTICLE_STATUSES } = require('../config/constants');
const User = require('../models/User');
const Article = require('../models/Article');
const ViewedArticle = require('../models/ViewedArticle');

const CATEGORIES = ['World', 'Politics', 'Tech', 'Sport', 'Culture', 'Business', 'Science', 'Health'];
const WORDS = ['election', 'elections', 'budget', 'startup', 'final', 'festival', 'climate', 'transit', 'housing', 'museum',
  'selection', 'market', 'vaccine', 'league', 'court', 'energy', 'drought', 'satellite', 'strike', 'summit'];
// Fixed device ids, so explain and manual checks can reuse them: one reader who opened half the site, one who opened a few.
const DEVICES = { heavy: createHash('sha256').update('dev3-load-heavy').digest('hex'), light: createHash('sha256').update('dev3-load-light').digest('hex') };
const BATCH = 1000;

// Deterministic pseudo-random numbers, so every run produces the same dataset.
function random(seed) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) % 2 ** 32; return state / 2 ** 32; };
}

async function main() {
  const count = Number(process.argv[2] || 5000);
  if (!Number.isInteger(count) || count < 1 || count > 50000) throw new Error('Article count must be an integer from 1 to 50000.');
  await connectDatabase(process.env.MONGODB_URI);
  if (!mongoose.connection.name.endsWith('_dev3')) throw new Error(`Refusing to seed database "${mongoose.connection.name}". Use a database name ending in _dev3.`);
  await Promise.all([Article.init(), ViewedArticle.init()]);

  let author = await User.findOne({ username: 'dev3-load' });
  if (!author) {
    author = new User({ username: 'dev3-load', displayName: 'Load Reporter', role: ROLES.REPORTER });
    await author.setPassword(randomBytes(24).toString('hex'));
    await author.save();
  }
  const old = await Article.find({ author: author._id }).select('_id').lean();
  for (let i = 0; i < old.length; i += BATCH) await ViewedArticle.deleteMany({ article: { $in: old.slice(i, i + BATCH).map(a => a._id) } });
  await Article.deleteMany({ author: author._id });

  const rand = random(42);
  const pick = list => list[Math.floor(rand() * list.length)];
  const yearAgo = Date.now() - 365 * 24 * 3600e3;
  const ids = [];
  for (let start = 0; start < count; start += BATCH) {
    const docs = Array.from({ length: Math.min(BATCH, count - start) }, (_, j) => {
      const i = start + j;
      const content = {
        title: `${pick(WORDS)} ${pick(WORDS)} report ${i + 1}`,
        summary: `Summary of load story ${i + 1}.`,
        body: `Opening paragraph of load story ${i + 1}.\nSecond paragraph.\nClosing paragraph.`,
        category: pick(CATEGORIES),
        imageUrl: ''
      };
      // Every third article shares its publication time with a neighbour, to exercise the _id tie-breaker.
      const publishedAt = new Date(yearAgo + Math.floor(i / 3) * 3 * (365 * 24 * 3600e3 / count));
      // Long-tail popularity: most articles have few views, so the popular sort is full of ties.
      const totalViews = Math.floor(rand() ** 4 * 1000);
      return { author: author._id, draft: content, published: content, status: ARTICLE_STATUSES.PUBLISHED, publishedAt, lastPublishedAt: publishedAt, totalViews };
    });
    const created = await Article.insertMany(docs, { lean: true });
    ids.push(...created.map(a => a._id));
  }

  // Viewed history: the heavy reader opened every other article, the light one 30, and 500 other devices about 20 each.
  const records = [
    ...ids.filter((_, i) => i % 2 === 0).map(article => ({ deviceId: DEVICES.heavy, article })),
    ...Array.from({ length: Math.min(30, ids.length) }, (_, i) => ({ deviceId: DEVICES.light, article: ids[Math.floor(i * ids.length / 30)] }))
  ];
  for (let d = 0; d < 500; d++) {
    const deviceId = createHash('sha256').update(`dev3-load-${d}`).digest('hex');
    for (const article of new Set(Array.from({ length: 20 }, () => pick(ids)))) records.push({ deviceId, article });
  }
  for (let i = 0; i < records.length; i += BATCH) await ViewedArticle.insertMany(records.slice(i, i + BATCH), { ordered: false, lean: true });

  console.log(`Seeded ${ids.length} published articles and ${records.length} viewed records into ${mongoose.connection.name}.`);
  console.log(`Heavy reader device: ${DEVICES.heavy}`);
  console.log(`Light reader device: ${DEVICES.light}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  }).finally(async () => { await mongoose.disconnect(); });
}

module.exports = { DEVICES };
