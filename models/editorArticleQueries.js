const Article = require('./Article');

const LIST_FIELDS = 'draft.title published.title status updatedAt author';
const SEARCH_RESULT_LIMIT = 20;

// Editors see every article regardless of status, so these queries are for Editor routes only.
async function listForEditor({ status, page, pageSize }) {
  const rows = await Article.find(status ? { status } : {})
    .select(LIST_FIELDS).sort({ updatedAt: -1, _id: -1 })
    .skip((page - 1) * pageSize).limit(pageSize + 1)
    .populate('author', 'displayName').lean();
  return { articles: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

function findForReview(id) {
  return Article.findById(id).populate('author', 'displayName').lean();
}

function findPublishedForAnalytics(id) {
  return Article.findOne({ _id: id, published: { $ne: null } }).select('published.title publishedAt').lean();
}

// Title word search uses the text index on published.title; without a term the newest articles are returned.
function searchPublishedTitles(term) {
  const published = { published: { $ne: null } };
  if (!term) {
    return Article.find(published).select('published.title publishedAt')
      .sort({ publishedAt: -1, _id: -1 }).limit(SEARCH_RESULT_LIMIT).lean();
  }
  return Article.find({ ...published, $text: { $search: term } })
    .select({ 'published.title': 1, publishedAt: 1, score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' }, _id: -1 }).limit(SEARCH_RESULT_LIMIT).lean();
}

module.exports = { listForEditor, findForReview, findPublishedForAnalytics, searchPublishedTitles };
