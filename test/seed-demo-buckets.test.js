const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  buildPublicationHistory, buildViewBuckets, buildArticles, isFootballArticle, baseRateFor, demoUserFilter, authoredByFilter, ofArticlesFilter,
  COUNTS, PUBLISHED_PLAN, FOOTBALL_ONE_IN, SEGMENT_RATE_MULTIPLIERS, RECENT_WINDOW_MS,
  BASE_VIEWS_PER_HOUR, MIN_PUBLICATION_GAP_MS, DAYS_BACK
} = require('../scripts/seedDemoFixtures');
const { DRAFT_FIELD_LIMITS } = require('../config/constants');

const { ObjectId } = mongoose.Types;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;
const FIXED_RANDOM = 0.5;
const NOW = Date.parse('2026-10-15T12:00:30Z');

function eventsAgo(...daysAgo) {
  return daysAgo.map(days => ({ _id: new ObjectId(), publishedAt: new Date(NOW - days * DAY_MS) }));
}

function viewsPerHour(buckets, publicationId) {
  const own = buckets.filter(bucket => String(bucket.publication) === String(publicationId));
  const views = own.reduce((sum, bucket) => sum + bucket.count, 0);
  const span = own.length > 1 ? own.at(-1).minute - own[0].minute + HOUR_MS : HOUR_MS;
  return views / (span / HOUR_MS);
}

test('buckets are minute aligned, positive and unique per minute and publication', () => {
  const events = eventsAgo(40, 25, 12, 3);
  const buckets = buildViewBuckets(new ObjectId(), events, NOW);
  const keys = new Set(buckets.map(bucket => `${bucket.minute.getTime()}|${bucket.publication}`));
  assert.equal(keys.size, buckets.length);
  assert.ok(buckets.every(bucket => bucket.minute.getTime() % MINUTE_MS === 0));
  assert.ok(buckets.every(bucket => Number.isSafeInteger(bucket.count) && bucket.count >= 1));
  assert.ok(buckets.every(bucket => bucket.minute.getTime() < NOW));
});

test('every bucket belongs to the publication that was current at that time', () => {
  const events = eventsAgo(20, 10);
  const buckets = buildViewBuckets(new ObjectId(), events, NOW);
  const updateMinute = events[1].publishedAt.getTime() - (events[1].publishedAt.getTime() % MINUTE_MS);
  for (const bucket of buckets) {
    const minute = bucket.minute.getTime();
    if (String(bucket.publication) === String(events[0]._id)) assert.ok(minute <= updateMinute);
    else assert.ok(minute >= updateMinute);
  }
});

test('the last 31 days always contain hourly data, even for an article published weeks ago', () => {
  const buckets = buildViewBuckets(new ObjectId(), eventsAgo(44), NOW);
  const recent = buckets.filter(bucket => NOW - bucket.minute.getTime() <= RECENT_WINDOW_MS);
  assert.equal(recent.length, RECENT_WINDOW_MS / HOUR_MS);
  recent.forEach((bucket, i) => {
    if (i > 0) assert.equal(bucket.minute.getTime() - recent[i - 1].minute.getTime(), HOUR_MS, 'no gaps between hourly buckets');
  });
  assert.ok(buckets.length <= RECENT_WINDOW_MS / HOUR_MS + DAYS_BACK, 'older history is one row per day, keeping the seed small');
});

test('an article published a moment ago still gets a bucket', () => {
  const buckets = buildViewBuckets(new ObjectId(), [{ _id: new ObjectId(), publishedAt: new Date(NOW - HOUR_MS) }], NOW);
  assert.ok(buckets.length >= 1);
});

test('each update changes the view rate by a clear step', t => {
  t.mock.method(Math, 'random', () => FIXED_RANDOM);
  assert.ok(SEGMENT_RATE_MULTIPLIERS.every((multiplier, i) => i === 0 || Math.abs(multiplier / SEGMENT_RATE_MULTIPLIERS[i - 1] - 1) >= 0.5));
  const events = eventsAgo(6, 4, 2);
  const buckets = buildViewBuckets(new ObjectId(), events, NOW);
  const rates = events.map(event => viewsPerHour(buckets, event._id));
  assert.ok(rates[1] > rates[0] * 2, 'second publication is clearly busier');
  assert.ok(rates[2] < rates[1] / 2, 'third publication is clearly quieter');
});


test('a publication history stores totalViews equal to the sum of its bucket counts', () => {
  const articleId = new ObjectId();
  const content = revision => ({ title: `Revision ${revision}` });
  for (const eventCount of [1, 2, 4]) {
    const history = buildPublicationHistory(articleId, new ObjectId(), content, eventCount, NOW);
    assert.equal(history.events.length, eventCount);
    assert.equal(history.totalViews, history.viewStats.reduce((sum, bucket) => sum + bucket.count, 0));
    assert.equal(String(history.currentPublication), String(history.events.at(-1)._id));
    assert.equal(history.published.title, `Revision ${eventCount - 1}`);
    assert.ok(history.viewStats.some(bucket => NOW - bucket.minute.getTime() <= RECENT_WINDOW_MS));
  }
});

const REPORTER_COUNT = 6;
const MIN_ARTICLES = 520;
const MULTI_UPDATE_EVENTS = 4;
const MIN_THEMED_SHARE = 0.10;
const MAX_THEMED_SHARE = 0.15;
const HEBREW_LETTERS = /[\u0590-\u05FF]/;
const MOJIBAKE_CHARACTERS = /[×Ã]/;
const MANCHESTER_UNITED = /Manchester United/;

function fakeUser(displayName) { return { _id: new ObjectId(), displayName }; }

function buildSeed() {
  const editor = fakeUser('Test Editor');
  const reporters = Array.from({ length: REPORTER_COUNT }, (_, i) => fakeUser(`Reporter ${i + 1}`));
  return { editor, reporters, ...buildArticles(editor, reporters) };
}

const seed = buildSeed();

function eventsOf(article) { return seed.events.filter(event => String(event.article) === String(article._id)); }
function published() { return seed.articles.filter(article => article.status === 'published'); }
function isThemed(article) { return MANCHESTER_UNITED.test(article.draft.title); }
function commentCounts(result) {
  const byArticle = new Map();
  for (const comment of result.comments) byArticle.set(String(comment.article), (byArticle.get(String(comment.article)) || 0) + 1);
  return result.articles.filter(article => article.status === 'published').map(article => byArticle.get(String(article._id)) || 0);
}

test('the seed builds the planned number of articles in all four statuses', () => {
  assert.ok(seed.articles.length >= MIN_ARTICLES);
  assert.equal(seed.articles.length, COUNTS.draft + COUNTS.returned + COUNTS.pending + COUNTS.published);
  assert.equal(COUNTS.published, PUBLISHED_PLAN.reduce((sum, step) => sum + step.articles, 0));
  for (const [status, count] of Object.entries({ draft: COUNTS.draft, returned: COUNTS.returned, pending: COUNTS.pending, published: COUNTS.published })) {
    assert.equal(seed.articles.filter(article => article.status === status).length, count, status);
  }
});

test('articles are spread over several reporters and every publication is by the editor', () => {
  assert.equal(new Set(seed.articles.map(article => String(article.author))).size, REPORTER_COUNT);
  assert.ok(seed.events.length > 0);
  assert.ok(seed.events.every(event => String(event.editor) === String(seed.editor._id)));
});

test('every returned article carries an editor note', () => {
  const returned = seed.articles.filter(article => article.status === 'returned');
  assert.equal(returned.length, COUNTS.returned);
  assert.ok(returned.every(article => article.editorNote.trim().length > 0));
});

test('some published articles were updated three times after their first publication', () => {
  const multiUpdate = published().filter(article => eventsOf(article).length === MULTI_UPDATE_EVENTS);
  assert.equal(multiUpdate.length, PUBLISHED_PLAN.find(step => step.publications === MULTI_UPDATE_EVENTS).articles);
  for (const article of multiUpdate) assert.deepEqual(eventsOf(article).map(event => event.kind), ['initial', 'update', 'update', 'update']);
});

test('returned and pending articles with a publication history have a draft that differs from the published version', () => {
  const withHistory = seed.articles.filter(article => article.status !== 'published' && article.published);
  assert.ok(withHistory.some(article => article.status === 'returned'));
  assert.ok(withHistory.some(article => article.status === 'pending'));
  for (const article of withHistory) {
    assert.notEqual(article.draft.body, article.published.body);
    assert.equal(eventsOf(article).length, 1);
    assert.equal(String(article.currentPublication), String(eventsOf(article)[0]._id));
  }
});

test('comment counts are deterministic and mix guest and registered commenters', () => {
  const again = buildSeed();
  assert.deepEqual(commentCounts(again), commentCounts(seed));
  assert.ok(seed.comments.length > 0);
  assert.ok(seed.comments.some(comment => comment.author === null));
  assert.ok(seed.comments.some(comment => comment.author !== null));
  assert.ok(seed.comments.every(comment => comment.displayName && comment.body));
});

test('the cleanup filters are scoped to demo- accounts and their articles, never empty', () => {
  const userId = new ObjectId();
  const articleId = new ObjectId();
  const prefix = new RegExp(demoUserFilter().username.$regex);
  assert.ok(prefix.test('demo-editor') && prefix.test('demo-reporter-3'));
  assert.ok(!prefix.test('editor') && !prefix.test('my-demo-editor') && !prefix.test('demo'));
  assert.deepEqual(authoredByFilter([userId]), { author: { $in: [userId] } });
  assert.deepEqual(ofArticlesFilter([articleId]), { article: { $in: [articleId] } });
  for (const filter of [demoUserFilter(), authoredByFilter([]), ofArticlesFilter([])]) assert.notDeepEqual(filter, {});
});

test('Manchester United Premier League stories are a themed minority filed under Sport', () => {
  const themed = seed.articles.filter(isThemed);
  const share = themed.length / seed.articles.length;
  assert.ok(share >= MIN_THEMED_SHARE && share <= MAX_THEMED_SHARE, `share was ${share}`);
  assert.ok(share < 0.5);
  assert.ok(themed.some(article => article.status === 'draft'));
  for (const status of ['returned', 'pending', 'published']) assert.ok(themed.some(article => article.status === status), status);
  for (const article of themed) {
    const categories = [article.draft.category, article.published?.category].filter(Boolean);
    assert.ok(categories.every(category => category === 'Sport'));
  }
  assert.ok(themed.some(article => /Premier League/.test(article.draft.summary)));
  assert.ok(seed.articles.some(article => !isThemed(article) && article.draft.category === 'World'));
});

test('some themed articles are among the multi-update published articles', () => {
  const themedMultiUpdate = published().filter(article => isThemed(article) && eventsOf(article).length === MULTI_UPDATE_EVENTS);
  assert.ok(themedMultiUpdate.length >= 1);
  const [article] = themedMultiUpdate;
  assert.match(article.published.body, /Update 3:/);
});

test('isFootballArticle picks one article in every FOOTBALL_ONE_IN', () => {
  const picked = Array.from({ length: MIN_ARTICLES }, (_, index) => index).filter(isFootballArticle);
  assert.ok(picked.every(index => index % FOOTBALL_ONE_IN === 0));
  assert.equal(picked.length, Math.ceil(MIN_ARTICLES / FOOTBALL_ONE_IN));
});

test('the Hebrew edge-case article contains real Hebrew and no mojibake', () => {
  const hebrew = published().find(article => HEBREW_LETTERS.test(article.published.title));
  assert.ok(hebrew, 'a published Hebrew article exists');
  for (const field of ['title', 'summary', 'body']) {
    assert.match(hebrew.published[field], HEBREW_LETTERS, field);
    assert.doesNotMatch(hebrew.published[field], MOJIBAKE_CHARACTERS, field);
  }
  assert.equal(hebrew.published.body.split('\n').length, 3);
});

test('every published article stores totalViews equal to the sum of its bucket counts', () => {
  const totals = new Map();
  for (const bucket of seed.viewStats) totals.set(String(bucket.article), (totals.get(String(bucket.article)) || 0) + bucket.count);
  for (const article of published()) assert.equal(article.totalViews, totals.get(String(article._id)), String(article._id));
});

const HISTORY_BUILDS_PER_COUNT = 300;
const MAX_AGE_MS = DAYS_BACK * DAY_MS;
const CLOCK_TOLERANCE_MS = MINUTE_MS;

function assertGapsAndWindow(events, now, label) {
  for (let i = 0; i < events.length; i++) {
    const age = now - events[i].publishedAt.getTime();
    assert.ok(age >= HOUR_MS - CLOCK_TOLERANCE_MS && age <= MAX_AGE_MS + CLOCK_TOLERANCE_MS, `${label}: event ${i} is outside the last ${DAYS_BACK} days`);
    if (i > 0) {
      const gap = events[i].publishedAt.getTime() - events[i - 1].publishedAt.getTime();
      assert.ok(gap >= MIN_PUBLICATION_GAP_MS, `${label}: gap ${gap} ms is below the minimum`);
    }
  }
}

test('publication events of one article are at least MIN_PUBLICATION_GAP_MS apart and within DAYS_BACK days', () => {
  for (const step of PUBLISHED_PLAN) {
    for (let build = 0; build < HISTORY_BUILDS_PER_COUNT; build++) {
      const history = buildPublicationHistory(new ObjectId(), new ObjectId(), () => ({}), step.publications, NOW);
      assertGapsAndWindow(history.events, NOW, `${step.publications} publications, build ${build}`);
    }
  }
  const byArticle = new Map();
  for (const event of seed.events) byArticle.set(String(event.article), [...(byArticle.get(String(event.article)) || []), event]);
  for (const [articleId, events] of byArticle) assertGapsAndWindow(events, Date.now(), articleId);
});

test('the base view rate is deterministic per article index and stays within BASE_VIEWS_PER_HOUR', () => {
  const rates = Array.from({ length: MIN_ARTICLES }, (_, index) => baseRateFor(index));
  assert.deepEqual(rates, Array.from({ length: MIN_ARTICLES }, (_, index) => baseRateFor(index)));
  assert.ok(rates.every(rate => Number.isInteger(rate) && rate >= BASE_VIEWS_PER_HOUR.min && rate <= BASE_VIEWS_PER_HOUR.max));
  assert.equal(new Set(rates).size, BASE_VIEWS_PER_HOUR.max - BASE_VIEWS_PER_HOUR.min + 1);
});

test('the base rate decides the view volume: only jitter is random inside a segment', () => {
  const events = eventsAgo(6);
  const sum = buckets => buckets.reduce((total, bucket) => total + bucket.count, 0);
  const slow = sum(buildViewBuckets(new ObjectId(), events, NOW, BASE_VIEWS_PER_HOUR.min));
  const fast = sum(buildViewBuckets(new ObjectId(), events, NOW, BASE_VIEWS_PER_HOUR.max));
  assert.ok(fast > slow);
});

test('every Reporter writes some Manchester United stories', () => {
  const authors = new Set(seed.articles.filter(isThemed).map(article => String(article.author)));
  assert.equal(authors.size, REPORTER_COUNT);
});

test('the title edge case sits exactly at the title length limit', () => {
  const longest = Math.max(...published().map(article => article.published.title.length));
  assert.equal(longest, DRAFT_FIELD_LIMITS.title);
});
