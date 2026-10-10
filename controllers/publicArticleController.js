const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const { publicComment } = require('../services/comments');
const { findPublicById, findLatestPublic } = require('../models/publicArticleQueries');
const visits = require('../services/visits');

const FEED_SIZE = 20;

function paragraphs(body) {
  return String(body || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Visit statistics must never delay or break a public page, whether recordVisit throws or rejects.
function recordVisitSafely(article, req) {
  Promise.resolve().then(() => visits.recordVisit(article, req))
    .catch(error => console.error('Visit not recorded:', error?.name));
}

function notFound(req, res) {
  res.status(404).render('notFound', { user: req.user, title: 'Article not found' });
}

async function showHome(req, res, next) {
  try {
    const articles = await findLatestPublic(FEED_SIZE);
    res.render('index', { user: req.user, articles });
  } catch (error) { next(error); }
}

async function showArticle(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(req, res);
  try {
    const article = await findPublicById(req.params.id);
    if (!article) return notFound(req, res);
    recordVisitSafely(article, req);
    const comments = await Comment.find({ article: article._id })
      .select('article displayName body createdAt')
      .sort({ createdAt: 1, _id: 1 }).lean();
    res.render('articles/show', {
      user: req.user, article, paragraphs: paragraphs(article.published.body),
      comments: comments.map(publicComment), styles: ['/article-comments.css'],
      title: article.published.title, description: article.published.summary
    });
  } catch (error) { next(error); }
}

module.exports = { FEED_SIZE, paragraphs, showHome, showArticle };
