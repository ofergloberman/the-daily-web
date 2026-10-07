const mongoose = require('mongoose');
const { ARTICLE_STATUSES } = require('../config/constants');
const { listForEditor, findForReview } = require('../models/editorArticleQueries');
const { parsePage } = require('../helpers/pagination');

const PAGE_SIZE = 20;
const STATUS_LABELS = Object.freeze({
  [ARTICLE_STATUSES.DRAFT]: 'Draft',
  [ARTICLE_STATUSES.PENDING]: 'Pending approval',
  [ARTICLE_STATUSES.PUBLISHED]: 'Published',
  [ARTICLE_STATUSES.RETURNED]: 'Returned for corrections'
});
const DRAFT_HEADINGS = Object.freeze({
  [ARTICLE_STATUSES.DRAFT]: 'Reporter draft (not submitted)',
  [ARTICLE_STATUSES.PENDING]: 'Waiting for approval',
  [ARTICLE_STATUSES.PUBLISHED]: 'Working copy',
  [ARTICLE_STATUSES.RETURNED]: 'Returned draft (waiting for corrections)'
});
const CONTENT_FIELDS = Object.freeze([
  ['title', 'Title'], ['summary', 'Summary'], ['category', 'Category'], ['imageUrl', 'Image URL'], ['body', 'Article text']
]);

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

// Pairs each field of the public snapshot with the working draft so the Editor sees exactly what approval would change.
function compareContent(article) {
  const published = article.published ?? null;
  return CONTENT_FIELDS.map(([key, label]) => {
    const current = published ? published[key] ?? '' : null;
    const proposed = article.draft?.[key] ?? '';
    return { key, label, current, proposed, changed: published !== null && current !== proposed };
  });
}

function notFound(req, res) {
  res.status(404).render('notFound', { user: req.user, title: 'Article not found' });
}

async function dashboard(req, res, next) {
  const page = parsePage(req.query.page);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  const { status } = req.query;
  if (status !== undefined && !Object.hasOwn(STATUS_LABELS, status)) return res.status(400).json({ error: 'INVALID_STATUS' });
  try {
    const { articles, hasNext } = await listForEditor({ status, page, pageSize: PAGE_SIZE });
    res.render('editor/dashboard', {
      user: req.user, title: 'Editor desk', styles: ['/editor.css'],
      articles, page, hasNext, status: status ?? '', statusLabels: STATUS_LABELS
    });
  } catch (error) { next(error); }
}

async function reviewArticle(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return notFound(req, res);
  try {
    const article = await findForReview(req.params.id);
    if (!article) return notFound(req, res);
    res.render('editor/review', {
      user: req.user, title: 'Review article', styles: ['/editor.css'],
      article, fields: compareContent(article), isHttpUrl,
      statusLabel: STATUS_LABELS[article.status], draftHeading: DRAFT_HEADINGS[article.status]
    });
  } catch (error) { next(error); }
}

module.exports = { PAGE_SIZE, compareContent, dashboard, reviewArticle };
