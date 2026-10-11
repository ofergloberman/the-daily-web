const mongoose = require('mongoose');
const Article = require('./Article');
const ViewedArticle = require('./ViewedArticle');
require('./User'); // populate('author') needs the User model registered, even outside the app.

// Public reads see only the approved snapshot. Never select draft or editorNote here.
const PUBLIC_FIELDS = 'published publishedAt lastPublishedAt author';
const CARD_FIELDS = 'published.title published.summary published.category published.imageUrl publishedAt totalViews author';
const CARD_PROJECTION = Object.fromEntries(CARD_FIELDS.split(' ').map(field => [field, 1]));
const PUBLISHED = { published: { $ne: null } };
const VIEWED_FILTERS = ['all', 'unviewed', 'viewed'];

// Keyset ordering per sort. _id breaks ties so every article has exactly one position.
// totalViews can change while a reader scrolls the popular feed: an article that moves above the
// cursor is skipped for that session, one that moves below it can repeat (feed.js drops repeats by id).
// Articles must have totalViews set (schema default 0); a document missing the field would fall out of
// the popular keyset once the cursor reaches 0.
const SORTS = {
  date: { field: 'publishedAt', order: { publishedAt: -1, _id: -1 } },
  popular: { field: 'totalViews', order: { totalViews: -1, _id: -1 } }
};

function findPublicById(id) {
  return Article.findOne({ _id: id, ...PUBLISHED })
    .select(PUBLIC_FIELDS).populate('author', 'displayName').lean();
}

// The cursor is the sort key and _id of the last article the client has. It is opaque to clients.
function encodeCursor(sort, article) {
  const value = sort === 'date' ? new Date(article.publishedAt).toISOString() : article.totalViews || 0;
  return Buffer.from(JSON.stringify({ s: sort, v: value, id: String(article._id) })).toString('base64url');
}

function decodeCursor(cursor, sort) {
  try {
    const { s, v, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (s !== sort || !mongoose.isValidObjectId(id)) return null;
    const value = sort === 'date' ? new Date(v) : v;
    if (sort === 'date' ? Number.isNaN(value.getTime()) : !Number.isSafeInteger(value) || value < 0) return null;
    return { value, id: new mongoose.Types.ObjectId(id) };
  } catch { return null; }
}

function feedFilter({ q, category, sort, after }) {
  // The feed needs a publication date to place an article; approval always sets one.
  const filter = { ...PUBLISHED, publishedAt: { $ne: null } };
  if (q) filter.$text = { $search: q };
  if (category) filter['published.category'] = category;
  if (after) {
    const { field } = SORTS[sort];
    filter.$or = [{ [field]: { $lt: after.value } }, { [field]: after.value, _id: { $lt: after.id } }];
  }
  return filter;
}

// Viewed/not-viewed is decided inside MongoDB: each candidate article is joined to this device's
// ViewedArticle record through the unique (deviceId, article) index, so the server never loads a
// device's whole history. Sorting and the keyset filter run before the join, and the join stops
// once limit + 1 matching articles are found.
function viewedPipeline({ filter, sort, viewed, deviceId, limit }) {
  return [
    { $match: filter },
    { $sort: SORTS[sort].order },
    { $lookup: { from: ViewedArticle.collection.collectionName, localField: '_id', foreignField: 'article', pipeline: [{ $match: { deviceId } }, { $project: { _id: 1 } }], as: 'viewedBy' } },
    { $match: { viewedBy: viewed === 'viewed' ? { $ne: [] } : { $eq: [] } } },
    { $limit: limit + 1 },
    { $project: CARD_PROJECTION }
  ];
}

async function viewedIdsAmong(deviceId, articles) {
  if (!deviceId || !articles.length) return new Set();
  const records = await ViewedArticle.find({ deviceId, article: { $in: articles.map(a => a._id) } }).select('article').lean();
  return new Set(records.map(record => String(record.article)));
}

async function findFeed({ q = '', category = '', sort = 'date', viewed = 'all', after = null, deviceId = null, limit }) {
  const filter = feedFilter({ q, category, sort, after });
  if (viewed === 'viewed' && !deviceId) return { articles: [], hasMore: false, nextCursor: null };
  const joined = viewed !== 'all' && deviceId;
  const articles = joined
    ? await Article.populate(await Article.aggregate(viewedPipeline({ filter, sort, viewed, deviceId, limit })), { path: 'author', select: 'displayName', options: { lean: true } })
    : await Article.find(filter).select(CARD_FIELDS).sort(SORTS[sort].order).limit(limit + 1).populate('author', 'displayName').lean();
  const hasMore = articles.length > limit;
  const page = articles.slice(0, limit);
  const seen = joined ? null : await viewedIdsAmong(deviceId, page);
  for (const article of page) article.viewed = joined ? viewed === 'viewed' : seen.has(String(article._id));
  return { articles: page, hasMore, nextCursor: hasMore ? encodeCursor(sort, page.at(-1)) : null };
}

function findPublicCategories() {
  return Article.distinct('published.category', { ...PUBLISHED, 'published.category': { $ne: '' } });
}

module.exports = {
  PUBLIC_FIELDS, CARD_FIELDS, SORTS, VIEWED_FILTERS,
  findPublicById, findFeed, findPublicCategories, encodeCursor, decodeCursor, feedFilter, viewedPipeline
};
