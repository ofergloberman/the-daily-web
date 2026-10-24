const ROLES = Object.freeze({ GUEST: 'guest', REPORTER: 'reporter', EDITOR: 'editor' });
const ARTICLE_STATUSES = Object.freeze({
  DRAFT: 'draft', PENDING: 'pending', PUBLISHED: 'published', RETURNED: 'returned'
});

// Allowed article.status transitions. There is no entry back to `draft`: once an
// article leaves draft, the Reporter keeps editing in place and resubmits.
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

// Maximum string length accepted for each DRAFT_EDITABLE_FIELDS entry. The
// Article content schema does not enforce maxlength on body/imageUrl, so the
// workflow layer is the only place these limits are checked.
const DRAFT_FIELD_LIMITS = Object.freeze({ title: 200, summary: 500, body: 50000, category: 80, imageUrl: 2048 });

// Allowed password length, shared by User.setPassword and the demo seed guard.
const PASSWORD_LENGTH = Object.freeze({ min: 8, max: 128 });

// Text limits shared by the User and Comment models and the code that validates input before it reaches them.
const USERNAME_MAX_LENGTH = 50;
const DISPLAY_NAME_MAX_LENGTH = 100;
const COMMENT_BODY_MAX_LENGTH = 2000;

// Limits for the account-maintenance list command.
const USER_LIST_LIMIT_MAX = 100;
const USER_LIST_OFFSET_MAX = 10000;

// Longest correction note an Editor can attach when returning an article.
const EDITOR_NOTE_MAX_LENGTH = 2000;

// Longest title search the Editor desk and the analytics article search accept; also the maxlength of both search boxes.
const EDITOR_SEARCH_MAX_LENGTH = 100;

// HTTP status a controller should respond with for each WorkflowError code.
const ERROR_HTTP_STATUS = Object.freeze({
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_TRANSITION: 409,
  DRAFT_LOCKED: 409,
  STALE_DRAFT: 409,
  INCOMPLETE_CONTENT: 400,
  NOTE_REQUIRED: 400,
  INVALID_CONTENT: 400
});

module.exports = {
  ROLES, ARTICLE_STATUSES, ARTICLE_TRANSITIONS,
  DRAFT_EDITABLE_FIELDS, REQUIRED_SUBMIT_FIELDS, DRAFT_FIELD_LIMITS, PASSWORD_LENGTH, EDITOR_NOTE_MAX_LENGTH,
  USERNAME_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, COMMENT_BODY_MAX_LENGTH, USER_LIST_LIMIT_MAX, USER_LIST_OFFSET_MAX,
  EDITOR_SEARCH_MAX_LENGTH, ERROR_HTTP_STATUS
};
