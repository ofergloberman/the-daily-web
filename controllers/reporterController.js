const workflow = require('../models/articleWorkflow');
const { ARTICLE_STATUSES } = require('../config/constants');
const { actor, sendWorkflowError } = require('../helpers/workflowResponse');
const { parsePage } = require('../helpers/pagination');
const { sendError } = require('../helpers/sendError');

const PAGE_SIZE = 20;
const REPORTER_LINK = Object.freeze({ href: '/reporter', text: 'Back to my articles' });

// An empty ?page= means the first page, as it did before the shared helper was used.
function requestedPage(req) {
  return parsePage(req.query.page || undefined);
}

function statusFilter(req) {
  return typeof req.query.status === 'string' ? req.query.status : '';
}

/** Page requests show an error page (JSON for fetch callers) for a WorkflowError; returns false for any other error. */
function sendWorkflowPageError(req, res, error) {
  if (!(error instanceof workflow.WorkflowError)) return false;
  sendError(req, res, error.status, error.code, error.message, REPORTER_LINK);
  return true;
}

/** An article is submittable once its required fields are complete AND any imageUrl is a well-formed http(s) address. */
function canSubmit(article) {
  return workflow.isContentComplete(article.draft) && workflow.isValidImageUrl(article.draft?.imageUrl);
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
    canSubmit: canSubmit(article),
    draftVersion: article.draftVersion,
    updatedAt: article.updatedAt
  };
}

async function dashboard(req, res, next) {
  const page = requestedPage(req);
  if (!page) return sendError(req, res, 400, 'INVALID_PAGE', 'That page number is not valid.', REPORTER_LINK);
  const status = statusFilter(req);
  try {
    const { articles, hasNext } = await workflow.listOwnArticlesPage(actor(req), { status, page, pageSize: PAGE_SIZE });
    res.render('reporterDashboard', { user: req.user, articles, page, hasNext, status });
  } catch (error) {
    if (sendWorkflowPageError(req, res, error)) return;
    next(error);
  }
}

async function listArticles(req, res, next) {
  const page = requestedPage(req);
  if (!page) return res.status(400).json({ error: 'INVALID_PAGE' });
  try {
    const { articles, hasNext } = await workflow.listOwnArticlesPage(actor(req), { status: statusFilter(req), page, pageSize: PAGE_SIZE });
    res.json({ page, hasNext, articles: articles.map(article => ({
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
    res.render('reporterEditor', { user: req.user, article, locked, canSubmit: !locked && canSubmit(article) });
  } catch (error) {
    if (sendWorkflowPageError(req, res, error)) return;
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
    const article = await workflow.submitForApproval(req.params.id, actor(req), (req.body || {}).baseVersion);
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, '/reporter');
    res.json({ article: publicArticle(article) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

module.exports = { dashboard, listArticles, createArticle, editArticle, saveDraft, submitArticle };

