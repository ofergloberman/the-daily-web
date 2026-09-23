const ROLES = Object.freeze({ GUEST: 'guest', REPORTER: 'reporter', EDITOR: 'editor' });
const ARTICLE_STATUSES = Object.freeze({
  DRAFT: 'draft', PENDING: 'pending', PUBLISHED: 'published', RETURNED: 'returned'
});

module.exports = { ROLES, ARTICLE_STATUSES };
