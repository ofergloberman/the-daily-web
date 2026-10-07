// Article domain contract (Developer 2). See docs/ARTICLE_CONTRACT.md for the
// narrative version of everything below.
//
// Step 1 scope: status transitions, public projection, validation rules, and
// stable method signatures so D3/D4 can code against this module without
// editing the Article schema themselves. The database-backed operations
// (createDraft, saveDraftContent, submitForApproval, editAsEditor,
// returnForCorrections, approve, deleteArticle, getOwnArticle,
// listOwnArticlesQuery) are implemented in Step 2; calling them now throws a
// clear "not implemented yet" error instead of silently doing the wrong thing.
const { ARTICLE_STATUSES, ARTICLE_TRANSITIONS, DRAFT_EDITABLE_FIELDS, REQUIRED_SUBMIT_FIELDS, ERROR_HTTP_STATUS } = require('../config/constants');

/**
 * Thrown by every articleWorkflow function on a rule violation. `code` is one
 * of the keys in ERROR_HTTP_STATUS (config/constants.js) - controllers should
 * use `ERROR_HTTP_STATUS[error.code]` (also available as `error.status`) to
 * choose the HTTP response.
 */
class WorkflowError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'WorkflowError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code] || 500;
  }
}

/** Throws WorkflowError('INVALID_TRANSITION') unless `from -> to` is allowed. */
function assertTransition(from, to) {
  if (!ARTICLE_TRANSITIONS[from]?.includes(to)) {
    throw new WorkflowError('INVALID_TRANSITION', `Cannot move an article from "${from}" to "${to}".`);
  }
}

/** True when every REQUIRED_SUBMIT_FIELDS entry in `content` is a non-blank string. */
function isContentComplete(content) {
  return REQUIRED_SUBMIT_FIELDS.every(field => typeof content?.[field] === 'string' && content[field].trim().length > 0);
}

/**
 * Public-safe shape of an article, or null if it has never been approved.
 * Always sourced from `article.published`, never `article.draft`.
 * @param {object} article - an Article document or lean object with at least
 *   `published`, `publishedAt`, `lastPublishedAt`, `author`, `totalViews`,
 *   and `currentPublication` populated/selected.
 * @returns {{ id: string, title: string, summary: string, body: string,
 *   category: string, imageUrl: string, author: *, publishedAt: Date,
 *   lastPublishedAt: Date, totalViews: number, currentPublication: * } | null}
 */
function getPublicProjection(article) {
  if (!article || article.published == null) return null;
  const { title, summary, body, category, imageUrl } = article.published;
  return {
    id: String(article._id),
    title, summary, body, category, imageUrl,
    author: article.author,
    publishedAt: article.publishedAt,
    lastPublishedAt: article.lastPublishedAt,
    totalViews: article.totalViews ?? 0,
    currentPublication: article.currentPublication ?? null
  };
}

function notImplemented(name) {
  throw new Error(`articleWorkflow.${name} is implemented in Step 2.`);
}

/**
 * Creates a new `draft`-status article owned by `user`.
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>>} [initialContent]
 * @returns {Promise<import('./Article')>}
 */
async function createDraft(user, initialContent) { notImplemented('createDraft'); }

/**
 * Fetches an article by id with an ownership check. Reporters may only fetch
 * their own articles; Editors bypass ownership. Throws WorkflowError('NOT_FOUND')
 * when the id doesn't exist or a Reporter doesn't own it (ownership failures
 * are reported as NOT_FOUND, not FORBIDDEN, to avoid revealing other authors'
 * article ids).
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<import('./Article')>}
 */
async function getOwnArticle(articleId, user) { notImplemented('getOwnArticle'); }

/**
 * A Mongoose query (not yet executed) for a Reporter/Editor's article list.
 * @param {{id: string, role: string}} user
 * @param {{ status?: string }} [filters]
 * @returns {import('mongoose').Query}
 */
function listOwnArticlesQuery(user, filters) { notImplemented('listOwnArticlesQuery'); }

/**
 * Autosave. Writes only DRAFT_EDITABLE_FIELDS keys present in `patch`; any
 * other key is ignored. Throws WorkflowError('DRAFT_LOCKED') while
 * `status === 'pending'`.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>>} patch
 * @returns {Promise<import('./Article')>}
 */
async function saveDraftContent(articleId, user, patch) { notImplemented('saveDraftContent'); }

/**
 * Reporter-only. `draft/returned/published -> pending`. Throws
 * WorkflowError('INCOMPLETE_CONTENT') unless isContentComplete(article.draft).
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<import('./Article')>}
 */
async function submitForApproval(articleId, user) { notImplemented('submitForApproval'); }

/**
 * Editor-only direct content edit. No status change.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>>} patch
 * @returns {Promise<import('./Article')>}
 */
async function editAsEditor(articleId, user, patch) { notImplemented('editAsEditor'); }

/**
 * Editor-only. `pending -> returned` with a required note. Throws
 * WorkflowError('NOTE_REQUIRED') if `note` is blank.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {string} note
 * @returns {Promise<import('./Article')>}
 */
async function returnForCorrections(articleId, user, note) { notImplemented('returnForCorrections'); }

/**
 * Editor-only. `pending -> published`. Copies `draft` into `published`
 * atomically, creates exactly one PublicationEvent (`kind: 'initial'` the
 * first time, `'update'` afterwards), and sets `currentPublication`.
 * Transactional: requires a replica-set MongoDB connection.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<import('./Article')>}
 */
async function approve(articleId, user) { notImplemented('approve'); }

/**
 * Editor-only cascading delete, transactional: Comments, PublicationEvents,
 * ViewStatistics, then the Article itself.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<void>}
 */
async function deleteArticle(articleId, user) { notImplemented('deleteArticle'); }

module.exports = {
  WorkflowError,
  assertTransition,
  isContentComplete,
  getPublicProjection,
  createDraft,
  getOwnArticle,
  listOwnArticlesQuery,
  saveDraftContent,
  submitForApproval,
  editAsEditor,
  returnForCorrections,
  approve,
  deleteArticle
};
