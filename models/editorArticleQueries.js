const Article = require('./Article');
const { escapeRegExp } = require('../helpers/escapeRegExp');

const LIST_FIELDS = 'draft.title published.title status updatedAt author';
const SEARCH_RESULT_LIMIT = 20;
// 'default' is newest first, or best title match when searching; 'popular' is most viewed first.
const SEARCH_SORTS = Object.freeze(['default', 'popular']);
const POPULAR_ORDER = { totalViews: -1, _id: -1 };

// The desk search matches the draft title (what waits for approval) or the live title, ignoring case.
// A regex rather than $text: the one text index belongs to public search and finds partial words only this way.
function editorDeskFilter({ status, q }) {
  const filter = status ? { status } : {};
  if (q) {
    const pattern = { $regex: escapeRegExp(q), $options: 'i' };
    filter.$or = [{ 'draft.title': pattern }, { 'published.title': pattern }];
  }
  return filter;
}

// Editors see every article regardless of status, so these queries are for Editor routes only.
async function listForEditor({ status, q, page, pageSize }) {
  const rows = await Article.find(editorDeskFilter({ status, q }))
    .select(LIST_FIELDS).sort({ updatedAt: -1, _id: -1 })
    .skip((page - 1) * pageSize).limit(pageSize + 1)
    .populate('author', 'displayName').lean();
  return { articles: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

function findForReview(id) {
  return Article.findById(id).populate('author', 'displayName').lean();
}

// Analytics needs a publication record: an article without currentPublication has no markers and no bucketed views.
const HAS_PUBLICATION = Object.freeze({ published: { $ne: null }, currentPublication: { $ne: null } });

function findPublishedForAnalytics(id) {
  return Article.findOne({ _id: id, ...HAS_PUBLICATION }).select('published.title publishedAt').lean();
}

// Title word search uses the text index on published.title; without a term the newest articles are returned.
function searchPublishedTitles(term, sort = 'default') {
  const published = HAS_PUBLICATION;
  const popular = sort === 'popular';
  if (!term) {
    return Article.find(published).select('published.title publishedAt totalViews')
      .sort(popular ? POPULAR_ORDER : { publishedAt: -1, _id: -1 }).limit(SEARCH_RESULT_LIMIT).lean();
  }
  return Article.find({ ...published, $text: { $search: term } })
    .select({ 'published.title': 1, publishedAt: 1, totalViews: 1, score: { $meta: 'textScore' } })
    .sort(popular ? POPULAR_ORDER : { score: { $meta: 'textScore' }, _id: -1 }).limit(SEARCH_RESULT_LIMIT).lean();
}

module.exports = { SEARCH_SORTS, editorDeskFilter, listForEditor, findForReview, findPublishedForAnalytics, searchPublishedTitles };
