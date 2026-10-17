const mongoose = require('mongoose');
const analytics = require('../models/analyticsOperations');
const { SEARCH_SORTS, findPublishedForAnalytics, searchPublishedTitles } = require('../models/editorArticleQueries');
const { SITE_TIME_ZONE } = require('../helpers/dates');
const { EDITOR_SEARCH_MAX_LENGTH } = require('../config/constants');

const DEFAULT_RANGE_DAYS = 7;
const DEFAULT_RANGE_MS = DEFAULT_RANGE_DAYS * analytics.DAY_MS;
const MAX_RANGE_DAYS = analytics.MAX_RANGE_MS / analytics.DAY_MS;

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Defaults to the last DEFAULT_RANGE_DAYS days; returns null when the query is not a valid, bounded range.
function parseRange(query) {
  const to = query.to === undefined ? new Date() : parseDate(query.to);
  if (!to) return null;
  const from = query.from === undefined ? new Date(to.getTime() - DEFAULT_RANGE_MS) : parseDate(query.from);
  if (!from) return null;
  const length = to.getTime() - from.getTime();
  return length > 0 && length <= analytics.MAX_RANGE_MS ? { from, to } : null;
}

function showPage(req, res) {
  const { article } = req.query;
  res.render('analytics/index', {
    user: req.user, title: 'Impact analytics', styles: ['/editor.css', '/analytics.css'],
    articleId: mongoose.isObjectIdOrHexString(article) ? article : '', timeZone: SITE_TIME_ZONE, searchMaxLength: EDITOR_SEARCH_MAX_LENGTH
  });
}

async function searchArticles(req, res, next) {
  const term = req.query.q ?? '';
  const sort = req.query.sort ?? SEARCH_SORTS[0];
  if (typeof term !== 'string' || term.length > EDITOR_SEARCH_MAX_LENGTH) {
    return fail(res, 400, 'INVALID_QUERY', `Search text must be at most ${EDITOR_SEARCH_MAX_LENGTH} characters.`);
  }
  if (typeof sort !== 'string' || !SEARCH_SORTS.includes(sort)) {
    return fail(res, 400, 'INVALID_QUERY', `Sort must be one of: ${SEARCH_SORTS.join(', ')}.`);
  }
  try {
    const articles = await searchPublishedTitles(term.trim(), sort);
    res.json({ data: articles.map(article => ({
      id: String(article._id), title: article.published.title, publishedAt: article.publishedAt, totalViews: article.totalViews ?? 0
    })) });
  } catch (error) { next(error); }
}

async function viewSeries(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return fail(res, 400, 'INVALID_ARTICLE_ID', 'Invalid article id.');
  const range = parseRange(req.query);
  if (!range) return fail(res, 400, 'INVALID_RANGE', `Send valid from and to times (ISO 8601), with from before to and at most ${MAX_RANGE_DAYS} days apart.`);
  try {
    const article = await findPublishedForAnalytics(req.params.id);
    if (!article) return fail(res, 404, 'ARTICLE_NOT_FOUND', 'No published article with this id.');
    const series = await analytics.getViewSeries(article._id, range.from, range.to);
    res.json({ data: { article: { id: String(article._id), title: article.published.title }, ...series } });
  } catch (error) { next(error); }
}

module.exports = { parseRange, showPage, searchArticles, viewSeries };
