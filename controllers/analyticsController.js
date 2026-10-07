const mongoose = require('mongoose');
const analytics = require('../models/analyticsOperations');
const { findPublishedForAnalytics, searchPublishedTitles } = require('../models/editorArticleQueries');
const { SITE_TIME_ZONE } = require('../helpers/dates');

const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_LENGTH = 100;

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Defaults to the last seven days; returns null when the query is not a valid, bounded range.
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
    articleId: mongoose.isObjectIdOrHexString(article) ? article : '', timeZone: SITE_TIME_ZONE
  });
}

async function searchArticles(req, res, next) {
  const term = req.query.q ?? '';
  if (typeof term !== 'string' || term.length > MAX_SEARCH_LENGTH) {
    return fail(res, 400, 'INVALID_QUERY', `Search text must be at most ${MAX_SEARCH_LENGTH} characters.`);
  }
  try {
    const articles = await searchPublishedTitles(term.trim());
    res.json({ data: articles.map(article => ({ id: String(article._id), title: article.published.title, publishedAt: article.publishedAt })) });
  } catch (error) { next(error); }
}

async function viewSeries(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return fail(res, 400, 'INVALID_ARTICLE_ID', 'Invalid article id.');
  const range = parseRange(req.query);
  if (!range) return fail(res, 400, 'INVALID_RANGE', 'Send valid from and to times (ISO 8601), with from before to and at most 366 days apart.');
  try {
    const article = await findPublishedForAnalytics(req.params.id);
    if (!article) return fail(res, 404, 'ARTICLE_NOT_FOUND', 'No published article with this id.');
    const series = await analytics.getViewSeries(article._id, range.from, range.to);
    res.json({ data: { article: { id: String(article._id), title: article.published.title }, ...series } });
  } catch (error) { next(error); }
}

module.exports = { parseRange, showPage, searchArticles, viewSeries };
