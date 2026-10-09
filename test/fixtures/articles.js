// Shared article fixture builders (Developer 2, article domain).
//
// Audience: any developer's tests (D1 auth, D3 public layer, D4 review/
// analytics) that need a plausible Article-shaped object without hand-rolling
// the schema's fields. These are plain data builders only - no database I/O,
// no Mongoose model import required by the caller - so they are safe to use
// in both unit tests (passed straight to `new Article(...)`/`Article.create`)
// and in integration/seed scripts (spread into whatever insert call you use).
//
// Every field defaults to something valid and submission-ready; override only
// what your test actually cares about. See docs/ARTICLE_CONTRACT.md §1 for
// the status machine these shapes must stay consistent with.
const mongoose = require('mongoose');

const DEFAULT_CONTENT = Object.freeze({
  title: 'Fixture headline',
  summary: 'Fixture summary used across tests.',
  body: 'Fixture body paragraph one.\n\nFixture body paragraph two.',
  category: 'World',
  imageUrl: 'https://example.com/fixture.jpg'
});

/**
 * Builds a plain object matching the Article schema, defaulting to a
 * complete, submittable `draft` status article authored by a fresh ObjectId.
 * Pass any Article field in `overrides` to replace the default; `draft` and
 * `published` are shallow-merged with their defaults rather than replaced
 * outright, so `articleFixture({ draft: { title: 'X' } })` only changes the
 * title.
 * @param {object} [overrides]
 * @returns {object}
 */
function articleFixture(overrides = {}) {
  const { draft, published, ...rest } = overrides;
  return {
    author: new mongoose.Types.ObjectId(),
    draft: { ...DEFAULT_CONTENT, ...draft },
    draftVersion: 0,
    published: published === undefined ? null : { ...DEFAULT_CONTENT, ...published },
    status: 'draft',
    editorNote: '',
    publishedAt: null,
    lastPublishedAt: null,
    currentPublication: null,
    totalViews: 0,
    ...rest
  };
}

/** A `draft` article: no `published` snapshot yet, never shown publicly. */
function draftArticleFixture(overrides = {}) {
  return articleFixture({ status: 'draft', ...overrides });
}

/** A `pending` article awaiting editor review; still no public snapshot unless overridden. */
function pendingArticleFixture(overrides = {}) {
  return articleFixture({ status: 'pending', ...overrides });
}

/**
 * A `published` article: `published` defaults to the same content as
 * `draft` (as if just approved) and publication timestamps are stamped `now`
 * unless overridden.
 */
function publishedArticleFixture(overrides = {}) {
  const now = new Date();
  return articleFixture({
    status: 'published',
    published: overrides.draft || DEFAULT_CONTENT,
    publishedAt: now,
    lastPublishedAt: now,
    currentPublication: new mongoose.Types.ObjectId(),
    ...overrides
  });
}

/** A `returned` article: previously submitted, sent back with a correction note. */
function returnedArticleFixture(overrides = {}) {
  return articleFixture({ status: 'returned', editorNote: 'Please add a source for this claim.', ...overrides });
}

module.exports = { articleFixture, draftArticleFixture, pendingArticleFixture, publishedArticleFixture, returnedArticleFixture };
