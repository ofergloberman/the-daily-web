const mongoose = require('mongoose');
const Article = require('./Article');

// Public reads see only the approved snapshot. Never select draft or editorNote here.
const PUBLIC_FIELDS = 'published publishedAt lastPublishedAt author';
const CARD_FIELDS = 'published.title published.summary published.category published.imageUrl publishedAt totalViews author';
const PUBLISHED = { published: { $ne: null } };

// Keyset ordering per sort. _id breaks ties so every article has exactly one position.
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

async function findFeed({ q = '', category = '', sort = 'date', after = null, limit }) {
  const articles = await Article.find(feedFilter({ q, category, sort, after }))
    .select(CARD_FIELDS).sort(SORTS[sort].order).limit(limit + 1)
    .populate('author', 'displayName').lean();
  const hasMore = articles.length > limit;
  const page = articles.slice(0, limit);
  return { articles: page, hasMore, nextCursor: hasMore ? encodeCursor(sort, page.at(-1)) : null };
}

function findPublicCategories() {
  return Article.distinct('published.category', { ...PUBLISHED, 'published.category': { $ne: '' } });
}

module.exports = {
  PUBLIC_FIELDS, CARD_FIELDS, SORTS,
  findPublicById, findFeed, findPublicCategories, encodeCursor, decodeCursor, feedFilter
};
