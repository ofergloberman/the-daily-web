const mongoose = require('mongoose');
const Article = require('./Article');
const ViewedArticle = require('./ViewedArticle');
require('./User'); // populate('author') needs the User model registered, even outside the app.

// Public reads see only the approved snapshot. Never select draft or editorNote here.
// currentPublication is read with the snapshot (approve writes both together) so a visit is attributed to the version served.
const PUBLIC_FIELDS = 'published publishedAt lastPublishedAt currentPublication author';
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

// Viewed/not-viewed is decided inside MongoDB, so the server never loads a device's whole history.
// "Not viewed" (and "viewed" with a text search, since $text cannot run inside a $lookup) walks the
// articles in feed order and joins each to this device's record through the unique (deviceId, article)
// index, stopping once limit + 1 matches are found.
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

// "Viewed" without a search can start from the device's own history instead, so a device that has read
// only a few articles does not make MongoDB walk the whole feed to find them (see historyIsSmaller).
function deviceHistoryPipeline({ filter, sort, deviceId, limit }) {
  return [
    { $match: { deviceId } },
    { $lookup: { from: Article.collection.collectionName, localField: 'article', foreignField: '_id', pipeline: [{ $match: filter }, { $project: CARD_PROJECTION }], as: 'article' } },
    { $unwind: '$article' },
    { $replaceRoot: { newRoot: '$article' } },
    { $sort: SORTS[sort].order },
    { $limit: limit + 1 }
  ];
}

async function viewedIdsAmong(deviceId, articles) {
  if (!deviceId || !articles.length) return new Set();
  const records = await ViewedArticle.find({ deviceId, article: { $in: articles.map(a => a._id) } }).select('article').lean();
  return new Set(records.map(record => String(record.article)));
}

// For "viewed" without a search, pick the cheaper side to start from. Starting from the history costs one
// article lookup per record the device has. Walking the feed costs about (limit + 1) * articles / records
// lookups, since that share of articles is viewed. History wins when records^2 <= (limit + 1) * articles:
// a device that opened 30 of 5000 articles starts from its history, one that opened 2500 walks the feed.
// Both counts read only index keys and run in one round trip. "articles" is the published feed (in the
// category, if one is chosen), so a small category is not walked on the strength of the whole site's size.
async function historyIsSmaller(deviceId, limit, category = '') {
  const [records, articles] = await Promise.all([
    ViewedArticle.countDocuments({ deviceId }),
    Article.countDocuments(feedFilter({ category, sort: 'date' }))
  ]);
  return records * records <= (limit + 1) * articles;
}

async function findFeed({ q = '', category = '', sort = 'date', viewed = 'all', after = null, deviceId = null, limit }) {
  const filter = feedFilter({ q, category, sort, after });
  if (viewed === 'viewed' && !deviceId) return { articles: [], hasMore: false, nextCursor: null };
  const joined = viewed !== 'all' && deviceId;
  const fromHistory = joined && viewed === 'viewed' && !q && await historyIsSmaller(deviceId, limit, category);
  const rows = !joined
    ? await Article.find(filter).select(CARD_FIELDS).sort(SORTS[sort].order).limit(limit + 1).lean()
    : fromHistory
      ? await ViewedArticle.aggregate(deviceHistoryPipeline({ filter, sort, deviceId, limit }))
      : await Article.aggregate(viewedPipeline({ filter, sort, viewed, deviceId, limit }));
  const hasMore = rows.length > limit;
  // Author names and this device's viewed marks are independent, so they share one database round trip.
  const [page, seen] = await Promise.all([
    Article.populate(rows.slice(0, limit), { path: 'author', select: 'displayName', options: { lean: true } }),
    joined ? null : viewedIdsAmong(deviceId, rows.slice(0, limit))
  ]);
  for (const article of page) article.viewed = joined ? viewed === 'viewed' : seen.has(String(article._id));
  return { articles: page, hasMore, nextCursor: hasMore ? encodeCursor(sort, page.at(-1)) : null };
}

function findPublicCategories() {
  return Article.distinct('published.category', { ...PUBLISHED, 'published.category': { $ne: '' } });
}

module.exports = {
  PUBLIC_FIELDS, CARD_FIELDS, SORTS, VIEWED_FILTERS,
  findPublicById, findFeed, findPublicCategories, encodeCursor, decodeCursor, feedFilter, viewedPipeline, deviceHistoryPipeline, historyIsSmaller
};
