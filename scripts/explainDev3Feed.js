// Checks the public feed against the large _dev3 dataset (npm run seed:dev3:load first):
// 1. explain: for every sort / filter / viewed combination, on the first page and deep in the feed,
//    which indexes MongoDB uses, how many documents it reads and how long findFeed takes.
// 2. walk: pages through whole feeds and checks every article appears exactly once, in order.
// Usage: npm run explain:dev3 [-- --walk]
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const Article = require('../models/Article');
const ViewedArticle = require('../models/ViewedArticle');
const { SORTS, CARD_FIELDS, feedFilter, viewedPipeline, deviceHistoryPipeline, historyIsSmaller, findFeed, decodeCursor, encodeCursor } = require('../models/publicArticleQueries');
const { DEVICES } = require('./seedDev3Load');

const LIMIT = 20;
const FILTERS = [{}, { category: 'Tech' }, { q: 'election' }, { q: 'election', category: 'Tech' }];
const VIEWS = [
  { viewed: 'all', device: 'heavy' },
  { viewed: 'unviewed', device: 'heavy' },
  { viewed: 'viewed', device: 'heavy' },
  { viewed: 'viewed', device: 'light' }
];

// Collects stage names, index names and document counts from any explain shape (find or aggregate, any server version).
function summarize(explain) {
  const out = { stages: new Set(), indexes: new Set(), docs: 0, keys: 0, collscans: 0 };
  (function walk(node, key) {
    if (Array.isArray(node)) return node.forEach(item => walk(item));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'rejectedPlans' || k === 'allPlansExecution') continue;
      if (k === 'stage' && typeof v === 'string') { out.stages.add(v); if (v === 'COLLSCAN') out.collscans++; }
      if (k === 'indexName') out.indexes.add(v);
      if (k === 'indexesUsed' && Array.isArray(v)) v.forEach(name => out.indexes.add(name));
      if (k === 'collectionScans' && typeof v === 'number') out.collscans += v;
      if (k === 'totalDocsExamined' && typeof v === 'number') out.docs += v;
      if (k === 'totalKeysExamined' && typeof v === 'number') out.keys += v;
      walk(v, k);
    }
  })(explain);
  return out;
}

// The same query findFeed would send, so its plan can be explained.
async function explainFor({ q = '', category = '', sort, viewed, deviceId, after }) {
  const filter = feedFilter({ q, category, sort, after });
  if (viewed === 'all') return Article.find(filter).select(CARD_FIELDS).sort(SORTS[sort].order).limit(LIMIT + 1).explain('executionStats');
  if (viewed === 'viewed' && !q && await historyIsSmaller(deviceId, LIMIT)) return ViewedArticle.aggregate(deviceHistoryPipeline({ filter, sort, deviceId, limit: LIMIT })).explain('executionStats');
  return Article.aggregate(viewedPipeline({ filter, sort, viewed, deviceId, limit: LIMIT })).explain('executionStats');
}

async function timed(fn) {
  const runs = [];
  for (let i = 0; i < 3; i++) { const start = performance.now(); await fn(); runs.push(performance.now() - start); }
  return Math.round(runs.sort((a, b) => a - b)[1]); // median of three
}

async function explain() {
  const rows = [];
  for (const sort of Object.keys(SORTS)) {
    for (const filters of FILTERS) {
      // "Deep" starts after the 1000th matching article, as if the reader had scrolled 50 pages.
      const deepArticle = await Article.findOne(feedFilter({ ...filters, sort })).sort(SORTS[sort].order).skip(1000).select('publishedAt totalViews').lean();
      for (const view of VIEWS) {
        for (const depth of ['first', 'deep']) {
          if (depth === 'deep' && !deepArticle) continue;
          const after = depth === 'deep' ? decodeCursor(encodeCursor(sort, deepArticle), sort) : null;
          const args = { ...filters, sort, viewed: view.viewed, deviceId: DEVICES[view.device], after };
          const plan = summarize(await explainFor(args));
          const ms = await timed(() => findFeed({ ...args, limit: LIMIT }));
          rows.push({
            sort, filter: [filters.q && `q=${filters.q}`, filters.category].filter(Boolean).join(' + ') || '-',
            viewed: `${view.viewed}${view.viewed === 'all' ? '' : ` (${view.device})`}`, page: depth,
            indexes: [...plan.indexes].join(', ') || '-', collscans: plan.collscans, docs: plan.docs, keys: plan.keys, ms
          });
        }
      }
    }
  }
  console.log('| sort | filter | viewed | page | indexes used | collscans | docs read | keys read | findFeed ms |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.sort} | ${r.filter} | ${r.viewed} | ${r.page} | ${r.indexes} | ${r.collscans} | ${r.docs} | ${r.keys} | ${r.ms} |`);
  const scans = rows.filter(r => r.collscans);
  console.log(scans.length ? `\n${scans.length} queries used a collection scan.` : '\nNo query used a collection scan.');
  return scans.length === 0;
}

async function walk() {
  let ok = true;
  const check = (condition, message) => { if (!condition) { ok = false; console.log(`FAIL ${message}`); } };
  for (const sort of Object.keys(SORTS)) {
    const { field } = SORTS[sort];
    for (const filters of [{}, { category: 'Tech' }, { q: 'election' }]) {
      const ids = {};
      for (const viewed of ['all', 'unviewed', 'viewed']) {
        const seen = [];
        let after = null;
        for (let page = 0; page < 1000; page++) {
          const result = await findFeed({ ...filters, sort, viewed, deviceId: DEVICES.heavy, after, limit: LIMIT });
          seen.push(...result.articles);
          if (!result.hasMore) break;
          after = decodeCursor(result.nextCursor, sort);
        }
        const keys = seen.map(a => String(a._id));
        const label = `${sort} ${JSON.stringify(filters)} ${viewed}`;
        check(new Set(keys).size === keys.length, `${label}: repeated articles`);
        // Keyset order: the sort field descending, then _id descending.
        check(seen.every((a, i) => i === 0 || (+seen[i - 1][field] > +a[field]) || (+seen[i - 1][field] === +a[field] && String(seen[i - 1]._id) > String(a._id))), `${label}: out of order`);
        ids[viewed] = keys;
      }
      const expected = await Article.countDocuments(feedFilter({ ...filters, sort }));
      const viewedIds = new Set((await ViewedArticle.find({ deviceId: DEVICES.heavy }).select('article').lean()).map(r => String(r.article)));
      const label = `${sort} ${JSON.stringify(filters)}`;
      check(ids.all.length === expected, `${label}: all has ${ids.all.length}, expected ${expected}`);
      check(ids.unviewed.length + ids.viewed.length === ids.all.length, `${label}: viewed + unviewed != all`);
      check(ids.viewed.every(id => viewedIds.has(id)) && ids.unviewed.every(id => !viewedIds.has(id)), `${label}: wrong viewed split`);
      console.log(`${label}: all ${ids.all.length}, unviewed ${ids.unviewed.length}, viewed ${ids.viewed.length}`);
    }
  }
  console.log(ok ? 'Every walk returned each article exactly once, in order.' : 'Walk found problems.');
  return ok;
}

async function main() {
  await connectDatabase(process.env.MONGODB_URI);
  if (!mongoose.connection.name.endsWith('_dev3')) throw new Error(`Refusing to run against "${mongoose.connection.name}". Use a database name ending in _dev3.`);
  const passed = process.argv.includes('--walk') ? await walk() : await explain();
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
