const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const { publicComment } = require('../services/comments');
const ViewedArticle = require('../models/ViewedArticle');
const { SORTS, VIEWED_FILTERS, findPublicById, findFeed, findPublicCategories, decodeCursor } = require('../models/publicArticleQueries');
const visits = require('../services/visits');

const FEED_SIZE = 20;
const LIMITS = { q: 100, category: 80, cursor: 200 };

function paragraphs(body) {
  return String(body || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Shared by the JSON feed and the no-JS homepage form, so both accept exactly the same input.
function parseFeedQuery(query) {
  const fields = {};
  const text = name => (typeof query[name] === 'string' ? query[name].trim() : '');
  const q = text('q'), category = text('category'), sort = text('sort') || 'date', cursor = text('cursor'), viewed = text('viewed') || 'all';
  if (Array.isArray(query.q) || q.length > LIMITS.q) fields.q = `Search must be a single value of at most ${LIMITS.q} characters.`;
  if (Array.isArray(query.category) || category.length > LIMITS.category) fields.category = 'Category is not valid.';
  if (!Object.hasOwn(SORTS, sort)) fields.sort = `Sort must be one of: ${Object.keys(SORTS).join(', ')}.`;
  if (Array.isArray(query.viewed) || !VIEWED_FILTERS.includes(viewed)) fields.viewed = `Viewed must be one of: ${VIEWED_FILTERS.join(', ')}.`;
  let after = null;
  if (cursor && !fields.sort) {
    after = cursor.length <= LIMITS.cursor ? decodeCursor(cursor, sort) : null;
    if (!after) fields.cursor = 'Cursor is not valid for this sort.';
  }
  if (Object.keys(fields).length) return { fields };
  return { value: { q, category, sort, viewed, after } };
}

function cardJson(article) {
  return {
    id: String(article._id),
    title: article.published.title || '', summary: article.published.summary || '',
    category: article.published.category || '', imageUrl: article.published.imageUrl || '',
    author: article.author?.displayName || '',
    publishedAt: new Date(article.publishedAt).toISOString(),
    viewed: Boolean(article.viewed)
  };
}

// Visit statistics must never delay or break a public page, whether recordVisit throws or rejects.
function recordVisitSafely(article, req) {
  Promise.resolve().then(() => visits.recordVisit(article, req))
    .catch(error => console.error('Visit not recorded:', error?.name));
}

// Viewed membership is a convenience for the feed filter; failing to store it must not break the page.
// Only browsers that already sent their device cookie are recorded: a cookieless client (crawler, link
// preview, curl) gets a new random id on every request and could never read that history back.
function cameWithDeviceCookie(req) {
  return Boolean(req.deviceId) && (req.headers.cookie || '').split(';').some(part => part.trim() === `wd_device=${req.deviceId}`);
}

function markViewedSafely(article, req) {
  if (req.method !== 'GET' || !cameWithDeviceCookie(req)) return;
  Promise.resolve().then(() => ViewedArticle.markViewed(req.deviceId, article._id))
    .catch(error => console.error('Viewed state not saved:', error?.name));
}

function notFound(req, res) {
  res.status(404).render('notFound', { user: req.user, title: 'Article not found' });
}

async function listArticles(req, res, next) {
  const { value, fields } = parseFeedQuery(req.query);
  if (fields) return res.status(400).json({ error: 'INVALID_FEED_QUERY', message: 'Check the search, filter and sort values.', fields });
  try {
    const { articles, hasMore, nextCursor } = await findFeed({ ...value, deviceId: req.deviceId, limit: FEED_SIZE });
    res.set('Cache-Control', 'private, no-cache'); // Viewed flags differ per device.
    res.json({ data: articles.map(cardJson), pagination: { nextCursor, hasMore } });
  } catch (error) { next(error); }
}

async function showHome(req, res, next) {
  // Without JS the controls and the "More articles" link submit here as normal GETs. Bad values fall back to the default feed.
  const parsed = parseFeedQuery(req.query);
  const filters = parsed.value || { q: '', category: '', sort: 'date', viewed: 'all', after: null };
  try {
    const [feed, categories] = await Promise.all([findFeed({ ...filters, deviceId: req.deviceId, limit: FEED_SIZE }), findPublicCategories()]);
    // Viewed state changes as the reader opens articles, so Back must not show a stale cached homepage.
    res.set('Cache-Control', 'private, no-cache');
    res.render('index', { user: req.user, ...feed, categories: categories.sort(), filters, sorts: Object.keys(SORTS), viewedFilters: VIEWED_FILTERS });
  } catch (error) { next(error); }
}

async function showArticle(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(req, res);
  try {
    const article = await findPublicById(req.params.id);
    if (!article) return notFound(req, res);
    recordVisitSafely(article, req);
    markViewedSafely(article, req);
    const comments = await Comment.find({ article: article._id })
      .select('article displayName body createdAt')
      .sort({ createdAt: 1, _id: 1 }).lean();
    res.render('articles/show', {
      user: req.user, article, paragraphs: paragraphs(article.published.body),
      comments: comments.map(publicComment), styles: ['/article-comments.css'],
      title: article.published.title, description: article.published.summary
    });
  } catch (error) { next(error); }
}

module.exports = { FEED_SIZE, paragraphs, parseFeedQuery, cardJson, listArticles, showHome, showArticle };
