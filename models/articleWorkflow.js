// Article domain contract (Developer 2). See docs/ARTICLE_CONTRACT.md for the
// narrative version of everything below.
//
// The model-layer workflow coordinates database operations across Article,
// PublicationEvent, Comment, and ViewStatistic. Controllers remain
// responsible for request handling (body/param shape, HTML vs JSON) and for
// invoking these functions with the authenticated actor (`req.user`, shaped
// as `{ id, role }` - D1's authenticated-user middleware).
const mongoose = require('mongoose');
const Article = require('./Article');
const PublicationEvent = require('./PublicationEvent');
const Comment = require('./Comment');
const ViewStatistic = require('./ViewStatistic');
const { ROLES, ARTICLE_STATUSES, ARTICLE_TRANSITIONS, DRAFT_EDITABLE_FIELDS, REQUIRED_SUBMIT_FIELDS, DRAFT_FIELD_LIMITS, ERROR_HTTP_STATUS } = require('../config/constants');

/**
 * Thrown by every articleWorkflow function on a rule violation. `code` is one
 * of the keys in ERROR_HTTP_STATUS (config/constants.js) - controllers should
 * use `error.status` (or `ERROR_HTTP_STATUS[error.code]`) to choose the HTTP
 * response.
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

// ---- internal helpers (not exported) ---------------------------------

function requireRole(user, role) {
  if (!user || user.role !== role) throw new WorkflowError('FORBIDDEN', `Only ${role} accounts may perform this action.`);
}

function requireAnyRole(user, roles) {
  if (!user || !roles.includes(user.role)) throw new WorkflowError('FORBIDDEN', 'You are not allowed to perform this action.');
}

function requireValidId(articleId) {
  if (!mongoose.isValidObjectId(articleId)) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  return articleId;
}

/**
 * Validates the `baseVersion` a client must send with every saveDraftContent
 * call - the draftVersion it last saw, used as an optimistic-concurrency
 * token. Required (not merely optional) so a client cannot accidentally skip
 * the out-of-order-write guard.
 */
function requireBaseVersion(patch) {
  const { baseVersion } = patch || {};
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    throw new WorkflowError('INVALID_CONTENT', 'A numeric baseVersion is required to save a draft.');
  }
  return baseVersion;
}

/** Picks only DRAFT_EDITABLE_FIELDS keys present in `patch`; validates each is a string. */
function pickDraftFields(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new WorkflowError('INVALID_CONTENT', 'Expected a content object.');
  }
  const picked = {};
  for (const field of DRAFT_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (typeof patch[field] !== 'string') throw new WorkflowError('INVALID_CONTENT', `Invalid ${field}.`);
    if (patch[field].length > DRAFT_FIELD_LIMITS[field]) throw new WorkflowError('INVALID_CONTENT', `${field} exceeds its maximum length.`);
    picked[field] = patch[field];
  }
  return picked;
}

/** Builds a `{ 'draft.field': value }` $set object, ignoring unknown keys. */
function buildDraftSet(patch) {
  const picked = pickDraftFields(patch);
  const set = {};
  for (const [field, value] of Object.entries(picked)) set[`draft.${field}`] = value;
  return set;
}

/** Plain snapshot object (title/summary/body/category/imageUrl) copied out of a draft subdocument. */
function snapshotFromDraft(draft) {
  const snapshot = {};
  for (const field of DRAFT_EDITABLE_FIELDS) snapshot[field] = draft?.[field] ?? '';
  return snapshot;
}

/** Runs a DB write, translating Mongoose validation/cast errors into WorkflowError('INVALID_CONTENT'). */
async function guardWrite(run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (error.name === 'ValidationError' || error.name === 'CastError') throw new WorkflowError('INVALID_CONTENT', error.message);
    throw error;
  }
}

// ---- exported operations -----------------------------------------------

/**
 * Creates a new `draft`-status article owned by `user`.
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>>} [initialContent]
 * @returns {Promise<import('./Article')>}
 */
async function createDraft(user, initialContent) {
  requireRole(user, ROLES.REPORTER);
  const draft = initialContent ? pickDraftFields(initialContent) : undefined;
  return guardWrite(() => Article.create({ author: user.id, status: ARTICLE_STATUSES.DRAFT, ...(draft ? { draft } : {}) }));
}

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
async function getOwnArticle(articleId, user) {
  requireAnyRole(user, [ROLES.REPORTER, ROLES.EDITOR]);
  const id = requireValidId(articleId);
  const filter = { _id: id };
  if (user.role === ROLES.REPORTER) filter.author = user.id;
  const article = await Article.findOne(filter);
  if (!article) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  return article;
}

/**
 * A Mongoose query (not yet executed) for a Reporter/Editor's article list.
 * @param {{id: string, role: string}} user
 * @param {{ status?: string }} [filters]
 * @returns {import('mongoose').Query}
 */
function listOwnArticlesQuery(user, { status } = {}) {
  requireAnyRole(user, [ROLES.REPORTER, ROLES.EDITOR]);
  if (status !== undefined && !Object.values(ARTICLE_STATUSES).includes(status)) {
    throw new WorkflowError('INVALID_CONTENT', 'Unknown status filter.');
  }
  const filter = {};
  if (user.role === ROLES.REPORTER) filter.author = user.id;
  if (status) filter.status = status;
  return Article.find(filter);
}

/**
 * Autosave. Writes only DRAFT_EDITABLE_FIELDS keys present in `patch`; any
 * other key is ignored. Throws WorkflowError('DRAFT_LOCKED') while
 * `status === 'pending'`. Requires `patch.baseVersion` to equal the
 * article's current `draftVersion` (optimistic concurrency): a request
 * carrying a stale version - delayed on the network, or superseded by
 * another tab/device that saved first - is rejected with
 * WorkflowError('STALE_DRAFT') instead of overwriting the newer content.
 * `error.latest = { draftVersion }` is attached so the caller can resync.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>> & {baseVersion: number}} patch
 * @returns {Promise<import('./Article')>}
 */
async function saveDraftContent(articleId, user, patch) {
  requireAnyRole(user, [ROLES.REPORTER, ROLES.EDITOR]);
  const id = requireValidId(articleId);
  const set = buildDraftSet(patch);
  const baseVersion = requireBaseVersion(patch);
  const filter = { _id: id };
  if (user.role === ROLES.REPORTER) filter.author = user.id;
  const current = await Article.findOne(filter);
  if (!current) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  if (current.status === ARTICLE_STATUSES.PENDING) throw new WorkflowError('DRAFT_LOCKED', 'This article is awaiting review and cannot be edited.');
  const updated = await guardWrite(() => Article.findOneAndUpdate(
    { ...filter, status: { $ne: ARTICLE_STATUSES.PENDING }, draftVersion: baseVersion },
    { $set: set, $inc: { draftVersion: 1 } }, { new: true, runValidators: true }
  ));
  if (updated) return updated;
  const latest = await Article.findOne(filter);
  if (!latest) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  if (latest.status === ARTICLE_STATUSES.PENDING) throw new WorkflowError('DRAFT_LOCKED', 'This article is awaiting review and cannot be edited.');
  const error = new WorkflowError('STALE_DRAFT', 'Newer changes were already saved from another session. Reload the latest draft before retrying.');
  error.latest = { draftVersion: latest.draftVersion };
  throw error;
}

/**
 * Reporter-only. `draft/returned/published -> pending`. Throws
 * WorkflowError('INCOMPLETE_CONTENT') unless isContentComplete(article.draft).
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<import('./Article')>}
 */
async function submitForApproval(articleId, user) {
  requireRole(user, ROLES.REPORTER);
  const id = requireValidId(articleId);
  const current = await Article.findOne({ _id: id, author: user.id });
  if (!current) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  assertTransition(current.status, ARTICLE_STATUSES.PENDING);
  if (!isContentComplete(current.draft)) throw new WorkflowError('INCOMPLETE_CONTENT', 'Title, summary, body, and category are required before submission.');
  const updated = await guardWrite(() => Article.findOneAndUpdate(
    { _id: id, author: user.id, status: current.status },
    { $set: { status: ARTICLE_STATUSES.PENDING } }, { new: true, runValidators: true }
  ));
  if (!updated) throw new WorkflowError('INVALID_TRANSITION', 'This article was already changed by another request.');
  return updated;
}

/**
 * Editor-only direct content edit. No status change.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {Partial<Record<DRAFT_EDITABLE_FIELDS[number], string>>} patch
 * @returns {Promise<import('./Article')>}
 */
async function editAsEditor(articleId, user, patch) {
  requireRole(user, ROLES.EDITOR);
  const id = requireValidId(articleId);
  const set = buildDraftSet(patch);
  const updated = await guardWrite(() => Article.findOneAndUpdate(
    { _id: id }, { $set: set }, { new: true, runValidators: true }
  ));
  if (!updated) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  return updated;
}

/**
 * Editor-only. `pending -> returned` with a required note. Throws
 * WorkflowError('NOTE_REQUIRED') if `note` is blank.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @param {string} note
 * @returns {Promise<import('./Article')>}
 */
async function returnForCorrections(articleId, user, note) {
  requireRole(user, ROLES.EDITOR);
  if (typeof note !== 'string' || !note.trim()) throw new WorkflowError('NOTE_REQUIRED', 'A correction note is required.');
  const id = requireValidId(articleId);
  const current = await Article.findById(id);
  if (!current) throw new WorkflowError('NOT_FOUND', 'Article not found.');
  assertTransition(current.status, ARTICLE_STATUSES.RETURNED);
  const updated = await guardWrite(() => Article.findOneAndUpdate(
    { _id: id, status: ARTICLE_STATUSES.PENDING },
    { $set: { status: ARTICLE_STATUSES.RETURNED, editorNote: note.trim() } }, { new: true, runValidators: true }
  ));
  if (!updated) throw new WorkflowError('INVALID_TRANSITION', 'This article was already handled by another request.');
  return updated;
}

/**
 * Editor-only. `pending -> published`. Copies `draft` into `published`
 * atomically, creates exactly one PublicationEvent (`kind: 'initial'` the
 * first time, `'update'` afterwards), and sets `currentPublication`.
 * Transactional: requires a replica-set MongoDB connection (see
 * docs/ARTICLE_CONTRACT.md §7). The write that flips status away from
 * `pending` is conditional on the status still being `pending`, so a racing
 * duplicate approval sees no match and fails instead of creating a second event.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<import('./Article')>}
 */
async function approve(articleId, user) {
  requireRole(user, ROLES.EDITOR);
  const id = requireValidId(articleId);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const current = await Article.findById(id).session(session);
      if (!current) throw new WorkflowError('NOT_FOUND', 'Article not found.');
      assertTransition(current.status, ARTICLE_STATUSES.PUBLISHED);
      const publishedAt = new Date();
      const kind = current.publishedAt ? 'update' : 'initial';
      const [event] = await PublicationEvent.create([{ article: current._id, editor: user.id, publishedAt, kind }], { session });
      const updated = await guardWrite(() => Article.findOneAndUpdate(
        { _id: id, status: ARTICLE_STATUSES.PENDING },
        {
          $set: {
            published: snapshotFromDraft(current.draft),
            status: ARTICLE_STATUSES.PUBLISHED,
            editorNote: '',
            publishedAt: current.publishedAt || publishedAt,
            lastPublishedAt: publishedAt,
            currentPublication: event._id
          }
        },
        { new: true, runValidators: true, session }
      ));
      if (!updated) throw new WorkflowError('INVALID_TRANSITION', 'This article was already handled by another request.');
      result = updated;
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Editor-only cascading delete, transactional: Comments, PublicationEvents,
 * ViewStatistics, then the Article itself.
 * @param {string} articleId
 * @param {{id: string, role: string}} user
 * @returns {Promise<void>}
 */
async function deleteArticle(articleId, user) {
  requireRole(user, ROLES.EDITOR);
  const id = requireValidId(articleId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const article = await Article.findById(id).session(session);
      if (!article) throw new WorkflowError('NOT_FOUND', 'Article not found.');
      await Comment.deleteMany({ article: id }).session(session);
      await PublicationEvent.deleteMany({ article: id }).session(session);
      await ViewStatistic.deleteMany({ article: id }).session(session);
      await Article.deleteOne({ _id: id }).session(session);
    });
  } finally {
    await session.endSession();
  }
}

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
