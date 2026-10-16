// Submission demo dataset: 520 articles across every status and category, six Reporter
// accounts and one Editor, comments (guest and registered), articles mid workflow
// (pending/returned, some re-reviewing an already-published update), published articles
// (some updated several times after first publication), and enough view-count history to
// draw the Impact Analytics graph and its publication markers. A minority of the articles
// are Manchester United / Premier League stories filed under Sport.
//
// Refuses any database whose name does not end in `_demo` and checks that, and the two
// DEMO_*_PASSWORD variables, before connecting (see scripts/demoGuard.js). Re-runnable: it
// first deletes the articles, comments, publication events, view statistics, viewed-article
// rows and sessions owned by `demo-*` accounts, updates those accounts, then recreates the content.
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const { ROLES, ARTICLE_STATUSES, DRAFT_FIELD_LIMITS } = require('../config/constants');
const { assertDemoUri, readDemoPasswords } = require('./demoGuard');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');
const ViewedArticle = require('../models/ViewedArticle');

const { ObjectId } = mongoose.Types;
const DEMO_PREFIX = 'demo-';
const EDITOR_NAME = 'Dana Editor';
const REPORTER_NAMES = ['Noa Reporter', 'Amit Reporter', 'Lior Reporter', 'Maya Reporter', 'Eli Reporter', 'Tamar Reporter'];
const CATEGORIES = ['World', 'Politics', 'Tech', 'Sport', 'Culture', 'Business', 'Health', 'Science'];
const ADJECTIVES = ['Local', 'National', 'Breaking', 'Exclusive', 'Weekend', 'Late-night', 'Early-morning', 'Surprise', 'Ongoing', 'Historic', 'Regional', 'Overnight', 'Annual', 'Unexpected'];
const TOPICS = [
  'election results', 'budget negotiations', 'startup funding round', 'championship final', 'film festival',
  'climate summit', 'transit strike', 'housing plan', 'museum opening', 'trade deal', 'product launch',
  'hospital funding', 'university research', 'stadium project', 'currency shift', 'border talks',
  'wildfire response', 'vaccine rollout', 'energy policy', 'space mission', 'referendum', 'merger talks',
  'harvest season', 'heatwave warning', 'festival lineup', 'policy reform', 'market rally', 'court ruling',
  'rescue operation', 'technology recall'
];
const FOOTBALL_CATEGORY = 'Sport';
const FOOTBALL_CLUB = 'Manchester United';
// One article in every FOOTBALL_ONE_IN is a Premier League story (about 11%). The number shares no factor
// with CATEGORIES.length (8), so the themed articles are not pinned to one category slot and reach every status.
// The author is chosen by football story number (see nextSlot), so every Reporter writes some of them.
const FOOTBALL_ONE_IN = 9;
const OPPONENTS = ['Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Tottenham', 'Newcastle', 'Aston Villa'];
const POSITIONS = ['striker', 'midfielder', 'goalkeeper', 'full-back', 'centre-back', 'winger'];
const FOOTBALL_ANGLES = Object.freeze([
  { label: 'match report', headline: opponent => `United edge ${opponent} in a tight Premier League clash` },
  { label: 'transfer news', headline: (_opponent, position) => `United open talks over a new ${position}` },
  { label: 'manager news', headline: opponent => `Manager outlines United's plan ahead of the ${opponent} game` },
  { label: 'injury news', headline: (_opponent, position) => `United ${position} doubtful after a training knock` },
  { label: 'fixtures', headline: opponent => `United's Premier League fixtures: ${opponent} are next at Old Trafford` }
]);
const GUEST_NAMES = ['Guest Reader', 'Anonymous', 'Visitor42', 'Curious Reader', 'First-time Visitor', 'Local Resident', 'Night Owl', 'Commuter', 'Longtime Subscriber', 'Passerby'];
const COMMENT_BODIES = [
  'Thanks for the clear reporting on this.',
  'Can you follow up with more detail on the numbers mentioned above?',
  'This matches what I saw locally this week.',
  'Good to see this covered, it affects a lot of people.',
  'I disagree with part of this, but appreciate the coverage.',
  'Any update expected soon on this story?',
  'Well written and easy to follow.',
  'Linking this for a few friends who asked about it.'
];
const EDGE_CASES = [
  content => ({ ...content, title: '<script>alert(1)</script> & "quoted" <b>bold</b> title test', summary: 'Edge case: HTML-special characters must render as plain text, never execute.' }),
  content => ({ ...content, title: 'A'.repeat(DRAFT_FIELD_LIMITS.title), summary: 'Edge case: title exactly at the maximum allowed length.' }),
  content => ({ ...content, imageUrl: '', summary: 'Edge case: article with no image.' }),
  content => ({
    ...content,
    title: 'כתבה לדוגמה בעברית: עדכון מזג האוויר והתחבורה',
    summary: 'כתבה לבדיקת תמיכה בטקסט בעברית ובכיווניות RTL בממשק.',
    body: 'פסקה ראשונה בעברית עם פרטי הסיפור.\nפסקה שנייה עם תגובות ונתונים נוספים.\nפסקה שלישית המסכמת את הנושא.'
  })
];
const RETURNED_EDITOR_NOTE = 'Please add a quote from an official source and double-check the figures in paragraph two.';

// How many articles get 1, 2 and 4 publications (the 4-publication ones have three approved updates).
const PUBLISHED_PLAN = Object.freeze([
  { publications: 1, articles: 255 },
  { publications: 2, articles: 50 },
  { publications: 4, articles: 25 }
]);
const MOST_PUBLICATIONS = Math.max(...PUBLISHED_PLAN.map(step => step.publications));
const COUNTS = Object.freeze({
  draft: 70, returned: 50, pending: 70,
  published: PUBLISHED_PLAN.reduce((sum, step) => sum + step.articles, 0)
});
// The first returned and the first pending articles re-review an update of an already-published article.
const REVIEW_ARTICLES_WITH_HISTORY = 20;
const INCOMPLETE_DRAFT_EVERY = 5;
const NO_IMAGE_EVERY = 4;
// Published article number n gets COMMENTS_PER_ARTICLE_PATTERN[n % length] comments.
const COMMENTS_PER_ARTICLE_PATTERN = Object.freeze([0, 0, 1, 2, 5]);
// Of every COMMENT_CYCLE comments, the first GUEST_COMMENTS_PER_CYCLE are from guests.
const COMMENT_CYCLE = 10;
const GUEST_COMMENTS_PER_CYCLE = 7;

const DAYS_BACK = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RECENT_WINDOW_DAYS = 7;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * DAY_MS;
const MIN_PUBLICATION_GAP_MS = 3 * DAY_MS;
const MAX_EXTRA_GAP_MS = 2 * DAY_MS;
const BASE_VIEWS_PER_HOUR = Object.freeze({ min: 4, max: 12 });
// Article number n gets base rate min + (n * stride) mod (number of rates). The stride (5) shares no factor
// with the 9 possible rates (4..12), so consecutive articles cycle through every rate.
const BASE_RATE_INDEX_STRIDE = 5;
// Rate multiplier of the 1st, 2nd, 3rd... publication of an article: each update is a clear step up or down.
const SEGMENT_RATE_MULTIPLIERS = Object.freeze([1, 3, 0.5, 2.5]);
const JITTER_MIN_PERCENT = 80;
const JITTER_MAX_PERCENT = 120;
const INSERT_BATCH_SIZE = 2000;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function minuteAlign(date) { return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS); }
function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function isFootballArticle(index) { return index % FOOTBALL_ONE_IN === 0; }

function baseRateFor(index) {
  const rateCount = BASE_VIEWS_PER_HOUR.max - BASE_VIEWS_PER_HOUR.min + 1;
  return BASE_VIEWS_PER_HOUR.min + (index * BASE_RATE_INDEX_STRIDE) % rateCount;
}

function regularTheme(category, index) {
  const adjective = ADJECTIVES[index % ADJECTIVES.length];
  const topic = TOPICS[index % TOPICS.length];
  return {
    category,
    title: `${adjective} ${category} story ${index + 1}: ${topic}`,
    summary: `A ${category.toLowerCase()} report on ${topic} affecting readers nationwide.`,
    opening: `Opening paragraph covering the ${topic} in the ${category} section.`
  };
}

function footballTheme(index) {
  const slot = Math.floor(index / FOOTBALL_ONE_IN);
  const angle = FOOTBALL_ANGLES[slot % FOOTBALL_ANGLES.length];
  const headline = angle.headline(OPPONENTS[slot % OPPONENTS.length], POSITIONS[slot % POSITIONS.length]);
  return {
    category: FOOTBALL_CATEGORY,
    title: `${FOOTBALL_CLUB} ${angle.label} ${index + 1}: ${headline}`,
    summary: `A Premier League ${angle.label} on ${FOOTBALL_CLUB}: ${headline}.`,
    opening: `Opening paragraph on ${headline}, with ${FOOTBALL_CLUB} fans in mind and the Premier League table as the backdrop.`
  };
}

function makeContent(category, index, revision) {
  const theme = isFootballArticle(index) ? footballTheme(index) : regularTheme(category, index);
  const updated = revision ? ` Updated ${revision} time${revision > 1 ? 's' : ''} since first publication.` : '';
  const bodyLines = [
    theme.opening,
    'Second paragraph with additional detail and reactions from officials.',
    'Closing paragraph summarizing next steps and the expected timeline.'
  ];
  for (let update = 1; update <= revision; update++) bodyLines.push(`Update ${update}: new information was added to this report after publication.`);
  return {
    title: theme.title, summary: theme.summary + updated, body: bodyLines.join('\n'), category: theme.category,
    imageUrl: index % NO_IMAGE_EVERY === 0 ? '' : `https://picsum.photos/seed/demo-${theme.category.toLowerCase()}-${index}/900/600`
  };
}

// Oldest-to-newest publication timestamps, at least MIN_PUBLICATION_GAP_MS apart, within the last DAYS_BACK days.
function pickEventTimestamps(now, count) {
  const maxAge = DAYS_BACK * DAY_MS;
  const longestChain = (count - 1) * (MIN_PUBLICATION_GAP_MS + MAX_EXTRA_GAP_MS);
  let age = rand(HOUR_MS, maxAge - longestChain);
  const ages = [age];
  for (let i = 1; i < count; i++) {
    age += MIN_PUBLICATION_GAP_MS + rand(0, MAX_EXTRA_GAP_MS);
    ages.push(age);
  }
  return ages.map(value => new Date(now - value)).reverse();
}

function jitteredViews(expectedViews) {
  return Math.max(1, Math.round(expectedViews * rand(JITTER_MIN_PERCENT, JITTER_MAX_PERCENT) / 100));
}

// One row per hour for the last RECENT_WINDOW_DAYS days (so the default graph is dense) and one per day before that.
// Every publication segment runs at the article's base rate times its own multiplier, which makes each update a visible step.
function buildViewBuckets(articleId, events, now, baseRate = BASE_VIEWS_PER_HOUR.min) {
  const recentStart = minuteAlign(new Date(now - RECENT_WINDOW_MS)).getTime();
  const viewStats = [];
  events.forEach((event, i) => {
    const segmentEnd = i + 1 < events.length ? events[i + 1].publishedAt.getTime() : now;
    const rate = baseRate * SEGMENT_RATE_MULTIPLIERS[i % SEGMENT_RATE_MULTIPLIERS.length];
    let time = minuteAlign(event.publishedAt).getTime();
    while (time < segmentEnd) {
      const next = time < recentStart ? Math.min(time + DAY_MS, recentStart) : time + HOUR_MS;
      viewStats.push({ article: articleId, publication: event._id, minute: new Date(time), count: jitteredViews(rate * (next - time) / HOUR_MS) });
      time = next;
    }
  });
  return viewStats;
}

// Builds the PublicationEvent history, the ViewStatistic rows (each attributed to the
// publication that was current at that time, like services/visits.js does), and the resulting
// published snapshot/timestamps for one article.
function buildPublicationHistory(articleId, editorId, contentForRevision, eventCount, now, baseRate) {
  const timestamps = pickEventTimestamps(now, eventCount);
  const events = timestamps.map((publishedAt, i) => ({
    _id: new ObjectId(), article: articleId, editor: editorId,
    publishedAt, kind: i === 0 ? 'initial' : 'update'
  }));
  const viewStats = buildViewBuckets(articleId, events, now, baseRate);
  const totalViews = viewStats.reduce((sum, bucket) => sum + bucket.count, 0);
  const published = contentForRevision(events.length - 1);
  return {
    events, viewStats, totalViews, published,
    publishedAt: events[0].publishedAt, lastPublishedAt: events.at(-1).publishedAt,
    currentPublication: events.at(-1)._id
  };
}

// Cleanup filters. Everything the seed deletes is reached through the `demo-` accounts.
function demoUserFilter() { return { username: { $regex: `^${escapeRegExp(DEMO_PREFIX)}` } }; }
function authoredByFilter(userIds) { return { author: { $in: userIds } }; }
function ofArticlesFilter(articleIds) { return { article: { $in: articleIds } }; }

async function findIds(model, filter) {
  const documents = await model.find(filter).select('_id').lean();
  return documents.map(document => document._id);
}

async function wipeDemoData() {
  const userIds = await findIds(User, demoUserFilter());
  const articleIds = await findIds(Article, authoredByFilter(userIds));
  for (const model of [Comment, PublicationEvent, ViewStatistic, ViewedArticle]) await model.deleteMany(ofArticlesFilter(articleIds));
  await Article.deleteMany({ _id: { $in: articleIds } });
  await Session.deleteMany({ user: { $in: userIds } });
}

// Users are updated in place, so a re-run keeps their ids and applies the current env password.
async function upsertUser(username, displayName, role, password) {
  const user = (await User.findOne({ username })) || new User({ username });
  user.displayName = displayName;
  user.role = role;
  await user.setPassword(password);
  await user.save();
  return user;
}

async function upsertUsers(passwords) {
  const editor = await upsertUser(`${DEMO_PREFIX}editor`, EDITOR_NAME, ROLES.EDITOR, passwords.editor);
  const reporters = [];
  for (const [i, displayName] of REPORTER_NAMES.entries()) {
    reporters.push(await upsertUser(`${DEMO_PREFIX}reporter-${i + 1}`, displayName, ROLES.REPORTER, passwords.reporter));
  }
  return { editor, reporters };
}

// Each article takes the next index; the index decides its author and category (and whether it is a football story).
// Football stories rotate through the Reporters by football story number, so no Reporter is left out.
function nextSlot(context) {
  const index = context.index++;
  const authorNumber = isFootballArticle(index) ? index / FOOTBALL_ONE_IN : index;
  return {
    index,
    authorId: context.reporters[authorNumber % context.reporters.length]._id,
    category: CATEGORIES[index % CATEGORIES.length]
  };
}

function applyHistory(context, doc, history) {
  Object.assign(doc, {
    published: history.published, publishedAt: history.publishedAt, lastPublishedAt: history.lastPublishedAt,
    currentPublication: history.currentPublication, totalViews: history.totalViews
  });
  context.events.push(...history.events);
  context.viewStats.push(...history.viewStats);
}

// In-progress drafts. A few are left intentionally incomplete (blank body/category),
// matching an article still mid-write rather than one ready to submit.
function addDrafts(context) {
  for (let i = 0; i < COUNTS.draft; i++) {
    const { index, authorId, category } = nextSlot(context);
    const content = makeContent(category, index, 0);
    const incomplete = i % INCOMPLETE_DRAFT_EVERY === 0;
    context.articles.push({
      _id: new ObjectId(), author: authorId, status: ARTICLE_STATUSES.DRAFT,
      draft: incomplete ? { ...content, body: '', category: '' } : content
    });
  }
}

// Pending/returned articles. The first ones simulate re-reviewing an update to an article that is
// already public, so the Editor review screen has a published-vs-draft diff to show, and the public
// page keeps serving the older approved snapshot meanwhile.
function addReviewArticles(context, status, count) {
  for (let i = 0; i < count; i++) {
    const { index, authorId, category } = nextSlot(context);
    const withHistory = i < REVIEW_ARTICLES_WITH_HISTORY;
    const doc = {
      _id: new ObjectId(), author: authorId, status,
      draft: makeContent(category, index, withHistory ? 1 : 0),
      editorNote: status === ARTICLE_STATUSES.RETURNED ? RETURNED_EDITOR_NOTE : ''
    };
    if (withHistory) {
      applyHistory(context, doc, buildPublicationHistory(doc._id, context.editor._id, revision => makeContent(category, index, revision), 1, context.now, baseRateFor(index)));
    }
    context.articles.push(doc);
  }
}

function publicationCounts() {
  return PUBLISHED_PLAN.flatMap(step => Array(step.articles).fill(step.publications));
}

// Published articles: most publish once; some receive one update; a handful receive several updates
// (initial + 3 more), which the Impact Analytics markers and the "several updates" requirement need.
function addPublishedArticles(context) {
  publicationCounts().forEach((eventCount, planIndex) => {
    const { index, authorId, category } = nextSlot(context);
    const articleId = new ObjectId();
    const history = buildPublicationHistory(articleId, context.editor._id, revision => makeContent(category, index, revision), eventCount, context.now, baseRateFor(index));
    const content = planIndex < EDGE_CASES.length ? EDGE_CASES[planIndex](history.published) : history.published;
    const doc = { _id: articleId, author: authorId, status: ARTICLE_STATUSES.PUBLISHED, draft: content };
    applyHistory(context, doc, { ...history, published: content });
    context.articles.push(doc);
  });
}

function buildComment(article, number, commenters) {
  const body = COMMENT_BODIES[number % COMMENT_BODIES.length];
  if (number % COMMENT_CYCLE < GUEST_COMMENTS_PER_CYCLE) {
    return { article: article._id, author: null, displayName: GUEST_NAMES[number % GUEST_NAMES.length], body };
  }
  const user = commenters[number % commenters.length];
  return { article: article._id, author: user._id, displayName: user.displayName, body };
}

// Mixes guest (no account) and registered (Reporter/Editor) commenters, so the feed shows both kinds.
function buildComments(articles, editor, reporters) {
  const commenters = [editor, ...reporters];
  const comments = [];
  articles.filter(article => article.status === ARTICLE_STATUSES.PUBLISHED).forEach((article, n) => {
    const count = COMMENTS_PER_ARTICLE_PATTERN[n % COMMENTS_PER_ARTICLE_PATTERN.length];
    for (let c = 0; c < count; c++) comments.push(buildComment(article, comments.length, commenters));
  });
  return comments;
}

function buildArticles(editor, reporters) {
  const context = { now: Date.now(), editor, reporters, index: 0, articles: [], events: [], viewStats: [] };
  addDrafts(context);
  addReviewArticles(context, ARTICLE_STATUSES.RETURNED, COUNTS.returned);
  addReviewArticles(context, ARTICLE_STATUSES.PENDING, COUNTS.pending);
  addPublishedArticles(context);
  const comments = buildComments(context.articles, editor, reporters);
  return { articles: context.articles, events: context.events, viewStats: context.viewStats, comments };
}

function printSummary({ dbName, users, articles, events, viewStats, comments }) {
  const byStatus = {};
  for (const article of articles) byStatus[article.status] = (byStatus[article.status] || 0) + 1;
  console.log(`\nSeeded demo data into "${dbName}":`);
  console.log(`  Articles: ${articles.length} (${Object.entries(byStatus).map(([status, count]) => `${status}=${count}`).join(', ')})`);
  console.log(`  Publication events: ${events.length}, view statistic buckets: ${viewStats.length}, comments: ${comments.length}`);
  console.log('\nDemo accounts (passwords come from DEMO_EDITOR_PASSWORD and DEMO_REPORTER_PASSWORD):');
  for (const user of users) console.log(`  ${user.role.padEnd(8)} ${user.username}`);
  const published = articles.find(article => article.status === ARTICLE_STATUSES.PUBLISHED && events.filter(event => String(event.article) === String(article._id)).length >= MOST_PUBLICATIONS);
  const pendingWithHistory = articles.find(article => article.status === ARTICLE_STATUSES.PENDING && article.published);
  console.log('\nSample article ids to open directly:');
  if (published) console.log(`  Published, updated several times: /articles/${published._id} (analytics: /analytics?article=${published._id})`);
  if (pendingWithHistory) console.log(`  Pending re-review of an already-published article: ${pendingWithHistory._id}`);
}

// Everything that must succeed before the first database write: URI check, password check, then connect.
async function startSeed({ env, connect }) {
  const dbName = assertDemoUri(env.MONGODB_URI);
  const passwords = readDemoPasswords(env);
  await connect(env.MONGODB_URI);
  return { dbName, passwords };
}

async function main() {
  const { dbName, passwords } = await startSeed({ env: process.env, connect: connectDatabase });
  await wipeDemoData();
  const { editor, reporters } = await upsertUsers(passwords);
  const { articles, events, viewStats, comments } = buildArticles(editor, reporters);
  await Article.insertMany(articles, { ordered: true });
  if (events.length) await PublicationEvent.insertMany(events, { ordered: true });
  if (comments.length) await Comment.insertMany(comments, { ordered: true });
  for (const batch of chunk(viewStats, INSERT_BATCH_SIZE)) await ViewStatistic.insertMany(batch, { ordered: false });
  printSummary({ dbName, users: [editor, ...reporters], articles, events, viewStats, comments });
}

module.exports = {
  buildArticles, buildPublicationHistory, buildViewBuckets, isFootballArticle, baseRateFor, startSeed,
  demoUserFilter, authoredByFilter, ofArticlesFilter,
  COUNTS, PUBLISHED_PLAN, FOOTBALL_ONE_IN, SEGMENT_RATE_MULTIPLIERS, RECENT_WINDOW_MS,
  BASE_VIEWS_PER_HOUR, MIN_PUBLICATION_GAP_MS, DAYS_BACK
};

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  }).finally(async () => { await mongoose.disconnect(); });
}
