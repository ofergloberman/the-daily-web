// Performance evidence for the Developer 4 queries, run against the seeded _demo database (npm run seed:demo first).
//   npm run explain:dev4                 explains and times every query; read-only.
//   npm run explain:dev4 -- --visits     sends real visits to a running server and checks the counters (writes view counts).
// Exits with a non-zero code on any collection scan, any median above SLOW_QUERY_MS, or any wrong visit count.
const mongoose = require('mongoose');
const { SERVER_SELECTION_TIMEOUT_MS } = require('../config/database');
const { ARTICLE_STATUSES, EDITOR_DESK_PAGE_SIZE } = require('../config/constants');
const { assertDemoUri, redactConnectionStrings } = require('./demoGuard');
const { summarize, timed } = require('./explainSummary');
const Article = require('../models/Article');
require('../models/User'); // registers the model that listForEditor populates the author from
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');
const analytics = require('../models/analyticsOperations');
const {
  SEARCH_SORTS, editorDeskFilter, deskListQuery, listForEditor, findPublishedForAnalytics, searchPublishedTitles
} = require('../models/editorArticleQueries');

const SLOW_QUERY_MS = 200;
const VISIT_REQUESTS = 1000;
const VISIT_CONCURRENCY = 50;
const DEFAULT_BASE_URL = 'http://localhost:3000';
const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1']);
const SEARCH_TERM = 'united';
const SHORT_RANGE_DAYS = 7;
const LONG_RANGE_DAYS = 45;
const MULTI_UPDATE_MIN_PUBLICATIONS = 2;
// The server records a visit after it has answered, so the counters are read until they catch up.
const COUNTS_SETTLE_TIMEOUT_MS = 10000;
const COUNTS_POLL_MS = 250;
const HEAD_SETTLE_MS = 1000;
const STATUS_FILTERS = Object.freeze(['', ...Object.values(ARTICLE_STATUSES)]);
const TABLE_HEADER = ['query', 'indexes used', 'collection scans', 'docs read', 'keys read', 'ms'];

// ---- pure helpers (tested without a database) ----------------------------------------------------

// Visits are only ever sent to this machine, so a typo in DEMO_BASE_URL cannot load-test someone else's server.
function assertLocalBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('DEMO_BASE_URL must be a full address such as http://localhost:3000.'); }
  if (!LOCAL_HOSTS.includes(url.hostname)) throw new Error(`Refusing to send visits to "${url.hostname}". Use ${LOCAL_HOSTS.join(' or ')}.`);
  return url.origin;
}

function articleUrl(baseUrl, articleId) {
  return `${baseUrl}/articles/${articleId}`;
}

function toMarkdownRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function formatTable(rows) {
  const lines = [toMarkdownRow(TABLE_HEADER), toMarkdownRow(TABLE_HEADER.map(() => '---'))];
  rows.forEach(row => lines.push(toMarkdownRow([row.name, row.indexes, row.collscans, row.docs, row.keys, row.ms])));
  return lines;
}

// A collection scan or a median above the limit fails the run; exactly the limit is still fast enough.
function evaluateRows(rows, slowMs = SLOW_QUERY_MS) {
  const problems = [];
  rows.forEach(row => {
    if (row.collscans > 0) problems.push(`${row.name}: collection scan`);
    if (row.ms > slowMs) problems.push(`${row.name}: ${row.ms} ms is above ${slowMs} ms`);
  });
  return { passed: problems.length === 0, problems };
}

// Runs task(index) for every index below total, with at most `limit` running at the same time.
async function runWithConcurrency(total, limit, task) {
  let next = 0;
  async function worker() {
    while (next < total) {
      const index = next;
      next += 1;
      await task(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, worker));
}

function compareGrowth(check, before, after, expected) {
  const actual = after - before;
  return { check, expected, actual, ok: actual === expected };
}

function checkVisitCounts({ before, after, expected }) {
  return [
    compareGrowth('Article.totalViews', before.totalViews, after.totalViews, expected),
    compareGrowth('sum of the view buckets', before.bucketSum, after.bucketSum, expected)
  ];
}

function formatChecks(checks) {
  return [
    toMarkdownRow(['check', 'expected growth', 'actual growth', 'result']),
    toMarkdownRow(['---', '---', '---', '---']),
    ...checks.map(item => toMarkdownRow([item.check, item.expected, item.actual, item.ok ? 'ok' : 'WRONG']))
  ];
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reads until the answer is good enough or the time is up, and returns the last answer either way.
async function readUntil(read, isEnough, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!isEnough(value) && Date.now() < deadline) {
    await pause(pollMs);
    value = await read();
  }
  return value;
}

// ---- database reads --------------------------------------------------------------------------------

// The seed gives some published articles several approved updates; the graph and the markers need one.
async function findMultiUpdateArticle() {
  const [top] = await PublicationEvent.aggregate([
    { $group: { _id: '$article', publications: { $sum: 1 } } },
    { $match: { publications: { $gte: MULTI_UPDATE_MIN_PUBLICATIONS } } },
    { $sort: { publications: -1, _id: 1 } },
    { $limit: 1 }
  ]);
  if (!top) throw new Error('No published article with several approved updates was found. Run npm run seed:demo first.');
  const article = await Article.findById(top._id).select('currentPublication').lean();
  return { id: top._id, currentPublication: article.currentPublication };
}

async function readLastPages() {
  const lastPages = {};
  for (const status of STATUS_FILTERS) {
    const count = await Article.countDocuments(editorDeskFilter({ status, q: '' }));
    lastPages[status] = Math.max(1, Math.ceil(count / EDITOR_DESK_PAGE_SIZE));
  }
  return lastPages;
}

async function readVisitCounts(articleId) {
  const [article, [buckets]] = await Promise.all([
    Article.findById(articleId).select('totalViews').lean(),
    ViewStatistic.aggregate([{ $match: { article: articleId } }, { $group: { _id: null, views: { $sum: '$count' } } }])
  ]);
  return { totalViews: article.totalViews ?? 0, bucketSum: buckets?.views ?? 0 };
}

// ---- the queries to explain ------------------------------------------------------------------------

// A case builds a fresh Query each time, because Mongoose will not run the same Query object twice.
function findCase(name, build, run = () => build()) {
  return { name, explain: () => build().explain('executionStats'), run };
}

function aggregateCase(name, pipeline, run) {
  return { name, explain: () => ViewStatistic.aggregate(pipeline).explain('executionStats'), run };
}

function statusName(status) {
  return status || 'all';
}

function deskCases(lastPages) {
  const cases = [];
  for (const status of STATUS_FILTERS) {
    for (const page of new Set([1, lastPages[status]])) {
      const args = { status, q: '', page, pageSize: EDITOR_DESK_PAGE_SIZE };
      cases.push(findCase(`desk list: ${statusName(status)}, page ${page}`, () => deskListQuery(args), () => listForEditor(args)));
    }
  }
  return cases;
}

function deskSearchCases() {
  return ['', ARTICLE_STATUSES.PENDING].map(status => {
    const args = { status, q: SEARCH_TERM, page: 1, pageSize: EDITOR_DESK_PAGE_SIZE };
    return findCase(`desk search "${SEARCH_TERM}": ${statusName(status)}`, () => deskListQuery(args), () => listForEditor(args));
  });
}

function analyticsSearchCases() {
  return ['', SEARCH_TERM].flatMap(term => SEARCH_SORTS.map(sort =>
    findCase(`analytics search: ${term ? `"${term}"` : 'no term'}, ${sort}`, () => searchPublishedTitles(term, sort))));
}

function seriesCase(article, days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * analytics.DAY_MS);
  const unit = analytics.chooseUnit(to.getTime() - from.getTime());
  const pipeline = analytics.viewSeriesPipeline(article.id, from, to, unit);
  return aggregateCase(`getViewSeries: ${days} days (${unit} unit)`, pipeline, () => analytics.getViewSeries(article.id, from, to));
}

function articleCases(article) {
  const bucketFilter = analytics.visitBucketFilter(article.id, article.currentPublication, new Date());
  return [
    findCase('findPublishedForAnalytics', () => findPublishedForAnalytics(article.id)),
    seriesCase(article, SHORT_RANGE_DAYS),
    seriesCase(article, LONG_RANGE_DAYS),
    findCase('publication markers (PublicationEvent)', () => analytics.publicationEventsQuery(article.id)),
    findCase('recordVisit: Article filter', () => Article.find({ _id: article.id })),
    findCase('recordVisit: view bucket filter', () => ViewStatistic.find(bucketFilter))
  ];
}

async function measure(queryCase) {
  const plan = summarize(await queryCase.explain());
  const ms = await timed(queryCase.run);
  return { name: queryCase.name, indexes: [...plan.indexes].join(', ') || '-', collscans: plan.collscans, docs: plan.docs, keys: plan.keys, ms };
}

async function explainQueries(article) {
  const cases = [...deskCases(await readLastPages()), ...deskSearchCases(), ...analyticsSearchCases(), ...articleCases(article)];
  const rows = [];
  for (const queryCase of cases) rows.push(await measure(queryCase));
  console.log(formatTable(rows).join('\n'));
  const { passed, problems } = evaluateRows(rows);
  console.log(passed ? `\nNo collection scans and every median is at most ${SLOW_QUERY_MS} ms.` : `\n${problems.join('\n')}`);
  return passed;
}

// ---- visit counting under load -----------------------------------------------------------------------

async function visitOnce(url) {
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

async function sendVisits(url) {
  let failed = 0;
  await runWithConcurrency(VISIT_REQUESTS, VISIT_CONCURRENCY, async () => {
    if (!(await visitOnce(url))) failed += 1;
  });
  return failed;
}

async function checkVisits(baseUrl, article) {
  const url = articleUrl(baseUrl, article.id);
  const before = await readVisitCounts(article.id);
  console.log(`Sending ${VISIT_REQUESTS} visits, ${VISIT_CONCURRENCY} at a time, to ${url}`);
  const failedRequests = await sendVisits(url);
  const grown = counts => counts.totalViews - before.totalViews >= VISIT_REQUESTS && counts.bucketSum - before.bucketSum >= VISIT_REQUESTS;
  const afterVisits = await readUntil(() => readVisitCounts(article.id), grown, COUNTS_SETTLE_TIMEOUT_MS, COUNTS_POLL_MS);

  await fetch(url, { method: 'HEAD' });
  await pause(HEAD_SETTLE_MS);
  const afterHead = await readVisitCounts(article.id);

  const label = (items, suffix) => items.map(item => ({ ...item, check: `${item.check}, ${suffix}` }));
  const checks = [
    ...label(checkVisitCounts({ before, after: afterVisits, expected: VISIT_REQUESTS }), `${VISIT_REQUESTS} GET requests`),
    ...label(checkVisitCounts({ before: afterVisits, after: afterHead, expected: 0 }), 'one HEAD request')
  ];
  console.log(formatChecks(checks).join('\n'));
  if (failedRequests > 0) console.log(`\n${failedRequests} of ${VISIT_REQUESTS} requests failed.`);
  return failedRequests === 0 && checks.every(item => item.ok);
}

// ---- entry point -----------------------------------------------------------------------------------------

async function main(argv = process.argv.slice(2), env = process.env) {
  const visitsMode = argv.includes('--visits');
  assertDemoUri(env.MONGODB_URI);
  const baseUrl = visitsMode ? assertLocalBaseUrl(env.DEMO_BASE_URL ?? DEFAULT_BASE_URL) : null;
  // No automatic index or collection creation, so this script never changes the database it is measuring.
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, autoIndex: false, autoCreate: false });
  const article = await findMultiUpdateArticle();
  const passed = visitsMode ? await checkVisits(baseUrl, article) : await explainQueries(article);
  if (!passed) process.exitCode = 1;
}

module.exports = {
  SLOW_QUERY_MS, VISIT_REQUESTS,
  assertLocalBaseUrl, articleUrl, formatTable, evaluateRows, runWithConcurrency, checkVisitCounts, formatChecks, readUntil, main
};

if (require.main === module) {
  main().catch(error => {
    console.error(redactConnectionStrings(error.message));
    process.exitCode = 1;
  }).finally(() => mongoose.disconnect().catch(() => {}));
}
