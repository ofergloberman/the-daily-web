// Submission demo dataset: ~500 articles across every status and category, several
// Reporter accounts and one Editor, comments (guest and registered), articles mid
// workflow (pending/returned, some re-reviewing an already-published update), published
// articles (some updated several times after first publication), and enough view-count
// history to draw the Impact Analytics graph and its publication markers.
//
// Runs only against a database whose name ends in `_demo` (safety guard, same pattern
// as scripts/seedDev3Fixtures.js) and is fully re-runnable: it first deletes every
// article, comment, publication event and view statistic owned by `demo-*` accounts,
// then recreates everything from scratch.
const mongoose = require('mongoose');
const { randomBytes } = require('node:crypto');
const { connectDatabase } = require('../config/database');
const { ROLES, ARTICLE_STATUSES } = require('../config/constants');
const User = require('../models/User');
const Session = require('../models/Session');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');

const DEMO_PREFIX = 'demo-';
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
  content => ({ ...content, title: `${'A'.repeat(190)} end-of-limit title`.slice(0, 199), summary: 'Edge case: title near the 200-character limit.' }),
  content => ({ ...content, imageUrl: '', summary: 'Edge case: article with no image.' }),
  content => ({
    ...content,
    title: 'כתבה לדוגמה בעברית: עדכון מזג האוויר והתחבורה',
    summary: 'כתבה לבדיקת תמיכה בטקסט בעברית וכיווניות RTL בממשק.',
    body: 'פסקה ראשונה בעברית עם פרטי הסיפור.\nפסקה שנייה עם תגובות ונתונים נוספים.\nפסקה שלישית המסכמת את הנושא.'
  })
];

const COUNTS = Object.freeze({ draft: 70, returned: 50, pending: 70, published: 310 });
const REPORTER_COUNT = REPORTER_NAMES.length;
const DAYS_BACK = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomPassword() { return randomBytes(10).toString('base64url'); }
function minuteAlign(date) { return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS); }
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function makeContent(category, index, revision) {
  const adjective = ADJECTIVES[index % ADJECTIVES.length];
  const topic = TOPICS[index % TOPICS.length];
  const title = `${adjective} ${category} story ${index + 1}: ${topic}`;
  const summary = `A ${category.toLowerCase()} report on ${topic} affecting readers nationwide.${revision ? ` Updated ${revision} time${revision > 1 ? 's' : ''} since first publication.` : ''}`;
  const bodyLines = [
    `Opening paragraph covering the ${topic} in the ${category} section.`,
    'Second paragraph with additional detail and reactions from officials.',
    'Closing paragraph summarizing next steps and the expected timeline.'
  ];
  for (let update = 1; update <= revision; update++) bodyLines.push(`Update ${update}: new information was added to this report after publication.`);
  return {
    title, summary, body: bodyLines.join('\n'), category,
    imageUrl: index % 4 === 0 ? '' : `https://picsum.photos/seed/demo-${category.toLowerCase()}-${index}/900/600`
  };
}

// Oldest-to-newest publication timestamps, at least 3 days apart, within the last DAYS_BACK days.
function pickEventTimestamps(now, count) {
  const minGap = 3 * DAY_MS;
  const maxAge = DAYS_BACK * DAY_MS;
  let age = rand(HOUR_MS, Math.max(HOUR_MS, maxAge - (count - 1) * minGap));
  const ages = [age];
  for (let i = 1; i < count; i++) {
    age += minGap + rand(0, 2 * DAY_MS);
    ages.push(Math.min(age, maxAge));
  }
  return ages.map(value => new Date(now - value)).reverse();
}

// Builds the PublicationEvent history, minute-bucketed ViewStatistic rows (attributing each
// bucket to whichever publication was current at that time, like services/visits.js does),
// and the resulting published snapshot/timestamps for one article.
function buildPublicationHistory(articleId, editorId, contentForRevision, eventCount, now) {
  const timestamps = pickEventTimestamps(now, eventCount);
  const events = timestamps.map((publishedAt, i) => ({
    _id: new mongoose.Types.ObjectId(), article: articleId, editor: editorId,
    publishedAt, kind: i === 0 ? 'initial' : 'update'
  }));
  const bucketCounts = new Map();
  events.forEach((event, i) => {
    const segmentStart = event.publishedAt.getTime();
    const segmentEnd = i + 1 < events.length ? events[i + 1].publishedAt.getTime() : now;
    const buckets = rand(15, 70);
    for (let b = 0; b < buckets; b++) {
      const time = segmentStart + Math.floor(Math.random() * Math.max(1, segmentEnd - segmentStart));
      const minuteKey = minuteAlign(new Date(time)).getTime();
      const key = `${minuteKey}|${event._id}`;
      bucketCounts.set(key, (bucketCounts.get(key) || 0) + rand(1, 25));
    }
  });
  const viewStats = [];
  let totalViews = 0;
  for (const [key, count] of bucketCounts) {
    const [minuteKey, publicationId] = key.split('|');
    viewStats.push({ article: articleId, publication: publicationId, minute: new Date(Number(minuteKey)), count });
    totalViews += count;
  }
  const published = contentForRevision(events.length - 1);
  return {
    events, viewStats, totalViews, published,
    publishedAt: events[0].publishedAt, lastPublishedAt: events.at(-1).publishedAt,
    currentPublication: events.at(-1)._id
  };
}

async function wipeDemoData() {
  const demoUsers = await User.find({ username: { $regex: `^${DEMO_PREFIX}` } }).select('_id').lean();
  const userIds = demoUsers.map(user => user._id);
  if (userIds.length) {
    const demoArticles = await Article.find({ author: { $in: userIds } }).select('_id').lean();
    const articleIds = demoArticles.map(article => article._id);
    if (articleIds.length) {
      await Comment.deleteMany({ article: { $in: articleIds } });
      await PublicationEvent.deleteMany({ article: { $in: articleIds } });
      await ViewStatistic.deleteMany({ article: { $in: articleIds } });
      await Article.deleteMany({ _id: { $in: articleIds } });
    }
    await Session.deleteMany({ user: { $in: userIds } });
    await User.deleteMany({ _id: { $in: userIds } });
  }
}

async function createUsers() {
  const credentials = [];
  const editor = new User({ username: `${DEMO_PREFIX}editor`, displayName: 'Dana Editor', role: ROLES.EDITOR });
  const editorPassword = randomPassword();
  await editor.setPassword(editorPassword);
  await editor.save();
  credentials.push({ username: editor.username, role: 'editor', password: editorPassword });

  const reporters = [];
  for (let i = 0; i < REPORTER_COUNT; i++) {
    const reporter = new User({ username: `${DEMO_PREFIX}reporter-${i + 1}`, displayName: REPORTER_NAMES[i], role: ROLES.REPORTER });
    const password = randomPassword();
    await reporter.setPassword(password);
    await reporter.save();
    reporters.push(reporter);
    credentials.push({ username: reporter.username, role: 'reporter', password });
  }
  return { editor, reporters, credentials };
}

function buildArticles(editor, reporters) {
  const now = Date.now();
  const articles = [];
  const events = [];
  const viewStats = [];
  let index = 0;
  const nextAuthor = () => reporters[index % reporters.length]._id;
  const nextCategory = () => CATEGORIES[index % CATEGORIES.length];

  // In-progress drafts. A few are left intentionally incomplete (blank body/category),
  // matching an article still mid-write rather than one ready to submit.
  for (let i = 0; i < COUNTS.draft; i++, index++) {
    const content = makeContent(nextCategory(), index, 0);
    const incomplete = i % 5 === 0;
    articles.push({
      _id: new mongoose.Types.ObjectId(), author: nextAuthor(), status: ARTICLE_STATUSES.DRAFT,
      draft: incomplete ? { ...content, body: '', category: '' } : content
    });
  }

  // Pending/returned articles. A portion simulate re-reviewing an update to an article
  // that is already public, so the Editor review screen has a published-vs-draft diff
  // to show, and the public page keeps serving the older approved snapshot meanwhile.
  function buildReviewArticle(status, withHistory) {
    const category = nextCategory();
    const baseIndex = index;
    const articleId = new mongoose.Types.ObjectId();
    const doc = {
      _id: articleId, author: nextAuthor(), status,
      draft: makeContent(category, baseIndex, withHistory ? 1 : 0),
      editorNote: status === ARTICLE_STATUSES.RETURNED
        ? 'Please add a quote from an official source and double-check the figures in paragraph two.' : ''
    };
    if (withHistory) {
      const history = buildPublicationHistory(articleId, editor._id, revision => makeContent(category, baseIndex, revision), 1, now);
      Object.assign(doc, {
        published: history.published, publishedAt: history.publishedAt, lastPublishedAt: history.lastPublishedAt,
        currentPublication: history.currentPublication, totalViews: history.totalViews
      });
      events.push(...history.events);
      viewStats.push(...history.viewStats);
    }
    articles.push(doc);
    index++;
  }
  for (let i = 0; i < COUNTS.returned; i++) buildReviewArticle(ARTICLE_STATUSES.RETURNED, i < 20);
  for (let i = 0; i < COUNTS.pending; i++) buildReviewArticle(ARTICLE_STATUSES.PENDING, i < 20);

  // Published articles: most publish once; some receive one update; a handful receive
  // several updates (initial + 3 more), which is what the Impact Analytics markers and
  // the "several updates after publication" requirement need to demonstrate.
  const publishedPlan = [...Array(245).fill(1), ...Array(50).fill(2), ...Array(15).fill(4)];
  publishedPlan.forEach((eventCount, planIndex) => {
    const category = nextCategory();
    const baseIndex = index;
    const articleId = new mongoose.Types.ObjectId();
    const history = buildPublicationHistory(articleId, editor._id, revision => makeContent(category, baseIndex, revision), eventCount, now);
    const published = planIndex < EDGE_CASES.length ? EDGE_CASES[planIndex](history.published) : history.published;
    articles.push({
      _id: articleId, author: nextAuthor(), status: ARTICLE_STATUSES.PUBLISHED,
      draft: published, published,
      publishedAt: history.publishedAt, lastPublishedAt: history.lastPublishedAt,
      currentPublication: history.currentPublication, totalViews: history.totalViews
    });
    events.push(...history.events);
    viewStats.push(...history.viewStats);
    index++;
  });

  // Comments on a third of the published articles, mixing guest (no account) and
  // registered (Reporter/Editor) commenters, so the feed demonstrates both kinds.
  const comments = [];
  const commenters = [editor, ...reporters];
  const published = articles.filter(article => article.status === ARTICLE_STATUSES.PUBLISHED);
  published.forEach((article, i) => {
    if (i % 3 !== 0) return;
    const count = rand(0, 5);
    for (let c = 0; c < count; c++) {
      const body = COMMENT_BODIES[rand(0, COMMENT_BODIES.length - 1)];
      if (Math.random() < 0.7) {
        comments.push({ article: article._id, author: null, displayName: GUEST_NAMES[rand(0, GUEST_NAMES.length - 1)], body });
      } else {
        const user = commenters[rand(0, commenters.length - 1)];
        comments.push({ article: article._id, author: user._id, displayName: user.displayName, body });
      }
    }
  });

  return { articles, events, viewStats, comments };
}

function printSummary({ dbName, credentials, articles, events, viewStats, comments }) {
  const byStatus = {};
  for (const article of articles) byStatus[article.status] = (byStatus[article.status] || 0) + 1;
  console.log(`\nSeeded demo data into "${dbName}":`);
  console.log(`  Articles: ${articles.length} (${Object.entries(byStatus).map(([status, count]) => `${status}=${count}`).join(', ')})`);
  console.log(`  Publication events: ${events.length}, view statistic buckets: ${viewStats.length}, comments: ${comments.length}`);
  console.log('\nDemo accounts (generated now; shown once, not stored anywhere):');
  for (const credential of credentials) console.log(`  ${credential.role.padEnd(8)} ${credential.username.padEnd(22)} ${credential.password}`);
  const published = articles.find(article => article.status === ARTICLE_STATUSES.PUBLISHED && events.filter(event => String(event.article) === String(article._id)).length >= 4);
  const pendingWithHistory = articles.find(article => article.status === ARTICLE_STATUSES.PENDING && article.published);
  console.log('\nSample article ids to open directly:');
  if (published) console.log(`  Published, updated several times: /articles/${published._id} (analytics: /analytics?article=${published._id})`);
  if (pendingWithHistory) console.log(`  Pending re-review of an already-published article: ${pendingWithHistory._id}`);
}

async function main() {
  await connectDatabase(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name;
  if (!/_demo$/i.test(dbName)) {
    throw new Error(`Refusing to seed database "${dbName}". Point MONGODB_URI at a database whose name ends in _demo (for example, add "/the_daily_web_demo" to the connection string before the query string) and run again.`);
  }
  await wipeDemoData();
  const { editor, reporters, credentials } = await createUsers();
  const { articles, events, viewStats, comments } = buildArticles(editor, reporters);
  await Article.insertMany(articles, { ordered: true });
  if (events.length) await PublicationEvent.insertMany(events, { ordered: true });
  if (comments.length) await Comment.insertMany(comments, { ordered: true });
  for (const batch of chunk(viewStats, 2000)) await ViewStatistic.insertMany(batch, { ordered: false });
  printSummary({ dbName, credentials, articles, events, viewStats, comments });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
