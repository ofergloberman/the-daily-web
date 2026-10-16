const mongoose = require('mongoose');
const { ARTICLE_STATUSES, DRAFT_FIELD_LIMITS, EDITOR_NOTE_MAX_LENGTH, EDITOR_SEARCH_MAX_LENGTH } = require('../config/constants');
const { listForEditor, findForReview } = require('../models/editorArticleQueries');
const { parsePage } = require('../helpers/pagination');
const { formatDate } = require('../helpers/dates');

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

function invalidDeskQuery(error, message) {
  return { error: { status: 400, error, message } };
}

// Shared by the desk page and the JSON route, so both accept exactly the same input.
function parseDeskQuery(query) {
  const page = parsePage(query.page);
  if (!page) return invalidDeskQuery('INVALID_PAGE', 'Page must be a positive whole number.');
  const { status } = query;
  if (status !== undefined && (typeof status !== 'string' || !Object.hasOwn(STATUS_LABELS, status))) {
    return invalidDeskQuery('INVALID_STATUS', `Status must be one of: ${Object.keys(STATUS_LABELS).join(', ')}.`);
  }
  if (query.q !== undefined && typeof query.q !== 'string') return invalidDeskQuery('INVALID_SEARCH', 'Search must be a single value.');
  const q = (query.q ?? '').trim();
  if (q.length > EDITOR_SEARCH_MAX_LENGTH) {
    return invalidDeskQuery('INVALID_SEARCH', `Search must be at most ${EDITOR_SEARCH_MAX_LENGTH} characters.`);
  }
  return { value: { page, status: status ?? '', q } };
}

function sendDeskError(res, { status, error, message }) {
  res.status(status).json({ error, message });
}

// The one place that decides how a desk row looks, for the EJS page and the JSON route alike.
// updatedLabel is the date text as readers see it, so the browser script never formats dates itself.
function toDeskRow(article) {
  return {
    id: String(article._id),
    title: article.draft?.title || article.published?.title || 'Untitled article',
    authorName: article.author?.displayName || 'Unknown reporter',
    updatedAt: article.updatedAt.toISOString(),
    updatedLabel: formatDate(article.updatedAt),
    status: article.status,
    statusLabel: STATUS_LABELS[article.status],
    isPublishedUpdate: Boolean(article.published) && article.status !== ARTICLE_STATUSES.PUBLISHED
  };
}

// Every desk link keeps the search and the status; empty values are left out of the address.
function deskUrl({ q, status, page }) {
  const query = new URLSearchParams(Object.entries({ q, status, page }).filter(([, value]) => value)).toString();
  return query ? `/editor?${query}` : '/editor';
}

async function loadDeskPage({ q, status, page }) {
  const { articles, hasNext } = await listForEditor({ q, status, page, pageSize: PAGE_SIZE });
  return { rows: articles.map(toDeskRow), hasNext };
}

async function dashboard(req, res, next) {
  const parsed = parseDeskQuery(req.query);
  if (parsed.error) return sendDeskError(res, parsed.error);
  const { q, status, page } = parsed.value;
  try {
    const { rows, hasNext } = await loadDeskPage(parsed.value);
    const chips = [{ label: 'All', status: '' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ label, status: value }))]
      .map(chip => ({ ...chip, url: deskUrl({ q, status: chip.status }), current: chip.status === status }));
    res.render('editor/dashboard', {
      user: req.user, title: 'Editor desk', styles: ['/editor.css'],
      rows, q, status, page, hasNext, chips, searchMaxLength: EDITOR_SEARCH_MAX_LENGTH,
      clearUrl: deskUrl({ status }),
      prevUrl: page > 1 ? deskUrl({ q, status, page: page - 1 }) : '',
      nextUrl: hasNext ? deskUrl({ q, status, page: page + 1 }) : ''
    });
  } catch (error) { next(error); }
}

async function listArticles(req, res, next) {
  const parsed = parseDeskQuery(req.query);
  if (parsed.error) return sendDeskError(res, parsed.error);
  try {
    const { rows, hasNext } = await loadDeskPage(parsed.value);
    res.json({ data: { articles: rows, page: parsed.value.page, hasNext } });
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
      statusLabel: STATUS_LABELS[article.status], draftHeading: DRAFT_HEADINGS[article.status],
      canDecide: article.status === ARTICLE_STATUSES.PENDING,
      limits: DRAFT_FIELD_LIMITS, noteMaxLength: EDITOR_NOTE_MAX_LENGTH
    });
  } catch (error) { next(error); }
}

module.exports = { PAGE_SIZE, compareContent, deskUrl, parseDeskQuery, toDeskRow, dashboard, listArticles, reviewArticle };
