const mongoose = require('mongoose');
const Article = require('../models/Article');
const { ARTICLE_STATUSES } = require('../config/constants');

const FIELDS = ['title', 'summary', 'body', 'category', 'imageUrl'];
const LIMITS = { title: 200, summary: 500, body: 50000, category: 80, imageUrl: 2048 };
const PAGE_SIZE = 20;

function pageNumber(value) {
  const page = Number(value || 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 10000 ? page : null;
}

function validId(req, res) {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ error: 'INVALID_ARTICLE_ID' });
  return false;
}

function publicArticle(article) {
  return {
    id: String(article._id), status: article.status,
    draft: Object.fromEntries(FIELDS.map(field => [field, article.draft?.[field] || ''])),
    updatedAt: article.updatedAt
  };
}

async function dashboard(req, res, next) {
  const page = pageNumber(req.query.page);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  try {
    const articles = await Article.find({ author: req.user._id })
      .select('draft.title status editorNote updatedAt').sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean();
    res.render('reporterDashboard', { user: req.user, articles: articles.slice(0, PAGE_SIZE), page, hasNext: articles.length > PAGE_SIZE });
  } catch (error) { next(error); }
}

async function listArticles(req, res, next) {
  const page = pageNumber(req.query.page);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  try {
    const articles = await Article.find({ author: req.user._id })
      .select('draft.title status editorNote updatedAt').sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean();
    res.json({ page, hasNext: articles.length > PAGE_SIZE, articles: articles.slice(0, PAGE_SIZE).map(article => ({
      id: String(article._id), title: article.draft?.title || 'Untitled article',
      status: article.status, editorNote: article.editorNote, updatedAt: article.updatedAt
    })) });
  } catch (error) { next(error); }
}

async function createArticle(req, res, next) {
  try {
    const article = await Article.create({ author: req.user._id, status: ARTICLE_STATUSES.DRAFT });
    console.info('Reporter created draft:', String(article._id));
    const location = `/reporter/articles/${article._id}/edit`;
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, location);
    res.status(201).location(location).json({ article: publicArticle(article), editUrl: location });
  } catch (error) { next(error); }
}

async function editArticle(req, res, next) {
  if (!validId(req, res)) return;
  try {
    const article = await Article.findOne({ _id: req.params.id, author: req.user._id, status: ARTICLE_STATUSES.DRAFT });
    if (!article) return res.status(404).json({ error: 'DRAFT_NOT_FOUND' });
    res.render('reporterEditor', { user: req.user, article });
  } catch (error) { next(error); }
}

function validateDraft(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a draft object.';
  const keys = Object.keys(body);
  if (keys.length !== FIELDS.length || keys.some(key => !FIELDS.includes(key))) return 'Send only title, summary, body, category, and imageUrl.';
  for (const field of FIELDS) {
    if (typeof body[field] !== 'string' || body[field].length > LIMITS[field]) return `Invalid ${field}.`;
  }
  // Preserve unfinished URLs as draft text; validate http/https before publication.
  return null;
}

async function saveDraft(req, res, next) {
  if (!validId(req, res)) return;
  const problem = validateDraft(req.body);
  if (problem) return res.status(400).json({ error: 'INVALID_DRAFT', message: problem });
  try {
    const changes = Object.fromEntries(FIELDS.map(field => [`draft.${field}`, req.body[field]]));
    const article = await Article.findOneAndUpdate(
      { _id: req.params.id, author: req.user._id, status: ARTICLE_STATUSES.DRAFT },
      { $set: changes }, { new: true, runValidators: true }
    );
    if (!article) return res.status(404).json({ error: 'DRAFT_NOT_FOUND' });
    res.json({ article: publicArticle(article) });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ error: 'INVALID_DRAFT' });
    next(error);
  }
}

module.exports = { dashboard, listArticles, createArticle, editArticle, saveDraft };
