const ROLES = Object.freeze({ GUEST: 'guest', REPORTER: 'reporter', EDITOR: 'editor' });
const ARTICLE_STATUSES = Object.freeze({
  DRAFT: 'draft', PENDING: 'pending', PUBLISHED: 'published', RETURNED: 'returned'
});

// Allowed article.status transitions. There is no entry back to `draft`: once an
// article leaves draft, the Reporter keeps editing in place and resubmits.
// See docs/ARTICLE_CONTRACT.md §1.
const ARTICLE_TRANSITIONS = Object.freeze({
  [ARTICLE_STATUSES.DRAFT]: Object.freeze([ARTICLE_STATUSES.PENDING]),
  [ARTICLE_STATUSES.PENDING]: Object.freeze([ARTICLE_STATUSES.PUBLISHED, ARTICLE_STATUSES.RETURNED]),
  [ARTICLE_STATUSES.RETURNED]: Object.freeze([ARTICLE_STATUSES.PENDING]),
  [ARTICLE_STATUSES.PUBLISHED]: Object.freeze([ARTICLE_STATUSES.PENDING])
});

// The only fields a content edit (Reporter autosave or Editor direct edit) may write.
// Any other request body key must be silently ignored by the workflow layer.
const DRAFT_EDITABLE_FIELDS = Object.freeze(['title', 'summary', 'body', 'category', 'imageUrl']);

// Fields that must be non-blank before an article can be submitted for approval.
// imageUrl is intentionally excluded: it stays optional.
const REQUIRED_SUBMIT_FIELDS = Object.freeze(['title', 'summary', 'body', 'category']);

// HTTP status a controller should respond with for each WorkflowError code.
const ERROR_HTTP_STATUS = Object.freeze({
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_TRANSITION: 409,
  DRAFT_LOCKED: 409,
  INCOMPLETE_CONTENT: 400,
  NOTE_REQUIRED: 400,
  INVALID_CONTENT: 400
});

module.exports = {
  ROLES, ARTICLE_STATUSES, ARTICLE_TRANSITIONS,
  DRAFT_EDITABLE_FIELDS, REQUIRED_SUBMIT_FIELDS, ERROR_HTTP_STATUS
};
