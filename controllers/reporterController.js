const workflow = require('../models/articleWorkflow');
const { ARTICLE_STATUSES } = require('../config/constants');

const PAGE_SIZE = 20;

function actor(req) {
  return { id: req.user.id, role: req.user.role };
}

function pageNumber(value) {
  const page = Number(value || 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 10000 ? page : null;
}

/** Sends the HTTP response for a WorkflowError and returns true, or returns false for any other error. */
function sendWorkflowError(res, error) {
  if (!(error instanceof workflow.WorkflowError)) return false;
  const body = { error: error.code, message: error.message };
  if (error.latest) body.latest = error.latest;
  res.status(error.status).json(body);
  return true;
}

function publicArticle(article) {
  return {
    id: String(article._id),
    status: article.status,
    editorNote: article.editorNote || '',
    draft: {
      title: article.draft?.title || '', summary: article.draft?.summary || '', body: article.draft?.body || '',
      category: article.draft?.category || '', imageUrl: article.draft?.imageUrl || ''
    },
    canSubmit: workflow.isContentComplete(article.draft),
    draftVersion: article.draftVersion,
    updatedAt: article.updatedAt
  };
}

async function dashboard(req, res, next) {
  const page = pageNumber(req.query.page);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  try {
    const articles = await workflow.listOwnArticlesQuery(actor(req), status ? { status } : {})
      .select('draft.title status editorNote updatedAt').sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean();
    res.render('reporterDashboard', { user: req.user, articles: articles.slice(0, PAGE_SIZE), page, hasNext: articles.length > PAGE_SIZE, status });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

async function listArticles(req, res, next) {
  const page = pageNumber(req.query.page);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  try {
    const articles = await workflow.listOwnArticlesQuery(actor(req), status ? { status } : {})
      .select('draft.title status editorNote updatedAt').sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean();
    res.json({ page, hasNext: articles.length > PAGE_SIZE, articles: articles.slice(0, PAGE_SIZE).map(article => ({
      id: String(article._id), title: article.draft?.title || 'Untitled article',
      status: article.status, editorNote: article.editorNote, updatedAt: article.updatedAt
    })) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

async function createArticle(req, res, next) {
  try {
    const article = await workflow.createDraft(actor(req));
    console.info('Reporter created draft:', String(article._id));
    const location = `/reporter/articles/${article._id}/edit`;
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, location);
    res.status(201).location(location).json({ article: publicArticle(article), editUrl: location });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

async function editArticle(req, res, next) {
  try {
    const article = await workflow.getOwnArticle(req.params.id, actor(req));
    const locked = article.status === ARTICLE_STATUSES.PENDING;
    res.render('reporterEditor', { user: req.user, article, locked, canSubmit: !locked && workflow.isContentComplete(article.draft) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

async function saveDraft(req, res, next) {
  try {
    const article = await workflow.saveDraftContent(req.params.id, actor(req), req.body);
    res.json({ article: publicArticle(article) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

async function submitArticle(req, res, next) {
  try {
    const article = await workflow.submitForApproval(req.params.id, actor(req));
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, '/reporter');
    res.json({ article: publicArticle(article) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

module.exports = { dashboard, listArticles, createArticle, editArticle, saveDraft, submitArticle };

