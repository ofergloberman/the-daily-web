const mongoose = require('mongoose');
const { findPublicById } = require('../models/publicArticleQueries');
const visits = require('../services/visits');

function paragraphs(body) {
  return String(body || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function notFound(req, res) {
  res.status(404).render('notFound', { user: req.user, title: 'Article not found' });
}

async function showArticle(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(req, res);
  try {
    const article = await findPublicById(req.params.id);
    if (!article) return notFound(req, res);
    visits.recordVisit(article, req).catch(error => console.error('Visit not recorded:', error.name));
    res.render('articles/show', {
      user: req.user, article, paragraphs: paragraphs(article.published.body),
      title: article.published.title, description: article.published.summary
    });
  } catch (error) { next(error); }
}

module.exports = { paragraphs, showArticle };
