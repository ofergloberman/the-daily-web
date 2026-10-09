const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const PublicationEvent = require('../models/PublicationEvent');
const Comment = require('../models/Comment');
const ViewStatistic = require('../models/ViewStatistic');
const workflow = require('../models/articleWorkflow');
const { ARTICLE_STATUSES, ROLES } = require('../config/constants');

function newId() {
  return new mongoose.Types.ObjectId().toString();
}

function makeDb() {
  return { articles: [], events: [] };
}

function matchesArticle(doc, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (value && typeof value === 'object' && '$ne' in value) {
      if (doc[key] === value.$ne) return false;
    } else if (doc[key] !== value) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) {
      if (path.includes('.')) {
        const [root, sub] = path.split('.');
        doc[root] = { ...doc[root], [sub]: value };
      } else {
        doc[path] = value;
      }
    }
  }
  if (update.$inc) {
    for (const [path, amount] of Object.entries(update.$inc)) doc[path] = (doc[path] || 0) + amount;
  }
}

// Installs in-memory mocks for every low-level call articleWorkflow.js makes,
// backed by a shared `db` so operations stay consistent across calls within a
// test. `calls` (optional) records a tag for each cascading delete call so
// deleteArticle's required cleanup order can be asserted.
function installMocks(t, db, calls = []) {
  t.mock.method(Article, 'create', async data => {
    const doc = {
      _id: newId(), author: data.author,
      draft: { title: '', summary: '', body: '', category: '', imageUrl: '', ...(data.draft || {}) },
      draftVersion: 0,
      published: null, status: data.status, editorNote: '',
      publishedAt: null, lastPublishedAt: null, currentPublication: null, totalViews: 0
    };
    db.articles.push(doc);
    return structuredClone(doc);
  });

  t.mock.method(Article, 'findOne', async filter => {
    const found = db.articles.find(doc => matchesArticle(doc, filter));
    return found ? structuredClone(found) : null;
  });

  t.mock.method(Article, 'findOneAndUpdate', async (filter, update) => {
    const found = db.articles.find(doc => matchesArticle(doc, filter));
    if (!found) return null;
    applyUpdate(found, update);
    return structuredClone(found);
  });

  t.mock.method(Article, 'findById', id => {
    const exec = async () => {
      const found = db.articles.find(doc => doc._id === id);
      return found ? structuredClone(found) : null;
    };
    return { session: () => exec(), then: (resolve, reject) => exec().then(resolve, reject) };
  });

  t.mock.method(Article, 'deleteOne', filter => ({
    session: async () => {
      calls.push('article');
      db.articles = db.articles.filter(doc => !matchesArticle(doc, filter));
    }
  }));

  t.mock.method(PublicationEvent, 'create', async (arg) => {
    const list = Array.isArray(arg) ? arg : [arg];
    const created = list.map(data => ({ _id: newId(), ...data }));
    db.events.push(...created);
    return created;
  });

  t.mock.method(PublicationEvent, 'deleteMany', filter => ({
    session: async () => { calls.push('publicationEvents'); db.events = db.events.filter(e => e.article !== filter.article); }
  }));
  t.mock.method(Comment, 'deleteMany', () => ({ session: async () => { calls.push('comments'); } }));
  t.mock.method(ViewStatistic, 'deleteMany', () => ({ session: async () => { calls.push('viewStatistics'); } }));

  // Transactions snapshot/restore the shared store so a throwing callback
  // rolls back every write it made, mirroring session.withTransaction().
  t.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(fn) {
      const before = structuredClone(db);
      try {
        return await fn();
      } catch (error) {
        db.articles = before.articles;
        db.events = before.events;
        throw error;
      }
    },
    async endSession() {}
  }));
}

test('assertTransition and isContentComplete enforce the status machine', () => {
  assert.doesNotThrow(() => workflow.assertTransition('draft', 'pending'));
  assert.throws(() => workflow.assertTransition('draft', 'published'), { name: 'WorkflowError', code: 'INVALID_TRANSITION' });
  assert.throws(() => workflow.assertTransition('published', 'draft'), { code: 'INVALID_TRANSITION' });
  assert.equal(workflow.isContentComplete({ title: 'T', summary: 'S', body: 'B', category: 'World' }), true);
  assert.equal(workflow.isContentComplete({ title: 'T', summary: '', body: 'B', category: 'World' }), false);
  assert.equal(workflow.isContentComplete({}), false);
});

test('getPublicProjection exposes only the approved snapshot', () => {
  assert.equal(workflow.getPublicProjection({ published: null }), null);
  assert.equal(workflow.getPublicProjection(null), null);
  const id = newId();
  const projection = workflow.getPublicProjection({
    _id: id, published: { title: 'T', summary: 'S', body: 'B', category: 'World', imageUrl: '' },
    draft: { title: 'Secret draft title' }, author: 'author-id', publishedAt: new Date('2026-01-01'),
    lastPublishedAt: new Date('2026-02-01'), totalViews: 5, currentPublication: 'event-id'
  });
  assert.equal(projection.id, id);
  assert.equal(projection.title, 'T');
  assert.equal(projection.totalViews, 5);
  assert.equal(projection.currentPublication, 'event-id');
  assert.equal('draft' in projection, false);
});

test('createDraft requires the reporter role and only stores editable fields', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  await assert.rejects(workflow.createDraft({ id: reporter.id, role: ROLES.EDITOR }), { code: 'FORBIDDEN' });
  const article = await workflow.createDraft(reporter, { title: 'Hello', author: 'hacked', status: 'published' });
  assert.equal(article.status, ARTICLE_STATUSES.DRAFT);
  assert.equal(article.draft.title, 'Hello');
  assert.equal(article.author, reporter.id);
  await assert.rejects(workflow.createDraft(reporter, { title: 42 }), { code: 'INVALID_CONTENT' });
});

test('getOwnArticle enforces ownership for Reporters but Editors bypass it', async t => {
  const db = makeDb();
  installMocks(t, db);
  const owner = { id: newId(), role: ROLES.REPORTER };
  const stranger = { id: newId(), role: ROLES.REPORTER };
  const editor = { id: newId(), role: ROLES.EDITOR };
  const created = await workflow.createDraft(owner);
  await assert.rejects(workflow.getOwnArticle(created._id, stranger), { code: 'NOT_FOUND' });
  const found = await workflow.getOwnArticle(created._id, owner);
  assert.equal(found._id, created._id);
  const foundByEditor = await workflow.getOwnArticle(created._id, editor);
  assert.equal(foundByEditor._id, created._id);
  await assert.rejects(workflow.getOwnArticle('not-an-id', owner), { code: 'NOT_FOUND' });
});

test('listOwnArticlesQuery scopes to the Reporter but not the Editor', () => {
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const editor = { id: newId(), role: ROLES.EDITOR };
  assert.deepEqual(workflow.listOwnArticlesQuery(reporter).getFilter(), { author: reporter.id });
  assert.deepEqual(workflow.listOwnArticlesQuery(editor).getFilter(), {});
  assert.deepEqual(
    workflow.listOwnArticlesQuery(reporter, { status: ARTICLE_STATUSES.DRAFT }).getFilter(),
    { author: reporter.id, status: 'draft' }
  );
  assert.throws(() => workflow.listOwnArticlesQuery(reporter, { status: 'bogus' }), { code: 'INVALID_CONTENT' });
});

test('saveDraftContent ignores unknown fields, enforces ownership, and locks while pending', async t => {
  const db = makeDb();
  installMocks(t, db);
  const owner = { id: newId(), role: ROLES.REPORTER };
  const stranger = { id: newId(), role: ROLES.REPORTER };
  const created = await workflow.createDraft(owner);

  const updated = await workflow.saveDraftContent(created._id, owner, { title: 'New title', status: 'published', author: 'hacker', baseVersion: 0 });
  assert.equal(updated.draft.title, 'New title');
  assert.equal(updated.status, ARTICLE_STATUSES.DRAFT);
  assert.equal(updated.draftVersion, 1);

  await assert.rejects(workflow.saveDraftContent(created._id, owner, { title: 'x' }), { code: 'INVALID_CONTENT' });
  await assert.rejects(workflow.saveDraftContent(created._id, stranger, { title: 'x', baseVersion: 1 }), { code: 'NOT_FOUND' });
  await assert.rejects(workflow.saveDraftContent(created._id, owner, { title: 5, baseVersion: 1 }), { code: 'INVALID_CONTENT' });

  db.articles.find(a => a._id === created._id).status = ARTICLE_STATUSES.PENDING;
  await assert.rejects(workflow.saveDraftContent(created._id, owner, { title: 'blocked', baseVersion: 1 }), { code: 'DRAFT_LOCKED' });
});

test('saveDraftContent rejects a stale baseVersion so out-of-order writes cannot overwrite newer ones', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const created = await workflow.createDraft(reporter);

  const afterFirst = await workflow.saveDraftContent(created._id, reporter, { title: 'first', baseVersion: 0 });
  assert.equal(afterFirst.draftVersion, 1);

  // A second, slower request still carrying the original baseVersion (e.g. a
  // retried/delayed request from another tab) must be rejected, not silently
  // overwrite the newer save.
  let error;
  await assert.rejects(
    workflow.saveDraftContent(created._id, reporter, { title: 'stale, delayed write', baseVersion: 0 }).catch(e => { error = e; throw e; }),
    { code: 'STALE_DRAFT' }
  );
  assert.equal(error.latest.draftVersion, 1);
  const current = await workflow.getOwnArticle(created._id, reporter);
  assert.equal(current.draft.title, 'first');
  assert.equal(current.draftVersion, 1);

  // Retrying with the version the conflict reported succeeds and advances again.
  const afterRetry = await workflow.saveDraftContent(created._id, reporter, { title: 'second', baseVersion: error.latest.draftVersion });
  assert.equal(afterRetry.draft.title, 'second');
  assert.equal(afterRetry.draftVersion, 2);
});

test('submitForApproval requires complete content and a valid transition', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const created = await workflow.createDraft(reporter, { title: 'T' });

  await assert.rejects(workflow.submitForApproval(created._id, reporter), { code: 'INCOMPLETE_CONTENT' });
  await workflow.saveDraftContent(created._id, reporter, { summary: 'S', body: 'B', category: 'World', baseVersion: 0 });

  const submitted = await workflow.submitForApproval(created._id, reporter);
  assert.equal(submitted.status, ARTICLE_STATUSES.PENDING);
  await assert.rejects(workflow.submitForApproval(created._id, reporter), { code: 'INVALID_TRANSITION' });
  await assert.rejects(workflow.submitForApproval(created._id, { id: newId(), role: ROLES.REPORTER }), { code: 'NOT_FOUND' });
});

test('editAsEditor requires the editor role and does not change status', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const created = await workflow.createDraft(reporter, { title: 'T', summary: 'S', body: 'B', category: 'World' });

  await assert.rejects(workflow.editAsEditor(created._id, reporter, { title: 'x' }), { code: 'FORBIDDEN' });
  const editor = { id: newId(), role: ROLES.EDITOR };
  const edited = await workflow.editAsEditor(created._id, editor, { title: 'Edited by editor' });
  assert.equal(edited.draft.title, 'Edited by editor');
  assert.equal(edited.status, ARTICLE_STATUSES.DRAFT);
  await assert.rejects(workflow.editAsEditor(newId(), editor, { title: 'x' }), { code: 'NOT_FOUND' });
});

test('returnForCorrections requires a note and only applies to pending articles', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const editor = { id: newId(), role: ROLES.EDITOR };
  const created = await workflow.createDraft(reporter, { title: 'T', summary: 'S', body: 'B', category: 'World' });

  await assert.rejects(workflow.returnForCorrections(created._id, editor, '   '), { code: 'NOTE_REQUIRED' });
  await assert.rejects(workflow.returnForCorrections(created._id, editor, 'Needs work'), { code: 'INVALID_TRANSITION' });
  await workflow.submitForApproval(created._id, reporter);

  const returned = await workflow.returnForCorrections(created._id, editor, 'Needs work');
  assert.equal(returned.status, ARTICLE_STATUSES.RETURNED);
  assert.equal(returned.editorNote, 'Needs work');
  await assert.rejects(workflow.returnForCorrections(created._id, reporter, 'x'), { code: 'FORBIDDEN' });
});

test('approve copies the draft snapshot, stamps initial vs update, and is retry-safe', async t => {
  const db = makeDb();
  installMocks(t, db);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const editor = { id: newId(), role: ROLES.EDITOR };
  const created = await workflow.createDraft(reporter, { title: 'V1', summary: 'S', body: 'B', category: 'World' });

  await assert.rejects(workflow.approve(created._id, editor), { code: 'INVALID_TRANSITION' });
  await workflow.submitForApproval(created._id, reporter);
  await assert.rejects(workflow.approve(created._id, reporter), { code: 'FORBIDDEN' });

  const published = await workflow.approve(created._id, editor);
  assert.equal(published.status, ARTICLE_STATUSES.PUBLISHED);
  assert.equal(published.published.title, 'V1');
  assert.ok(published.publishedAt);
  assert.equal(published.currentPublication, db.events[0]._id);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].kind, 'initial');

  // A retried/duplicate approval on an already-published article must not
  // create a second event: the transaction rolls back the event it staged
  // once the conditional status===pending update finds no match. True
  // simultaneous-request races are guarded the same way (atomic conditional
  // update inside the transaction) and are exercised against a real
  // replica-set MongoDB in integration testing, not this mocked unit test.
  await assert.rejects(workflow.approve(created._id, editor), { code: 'INVALID_TRANSITION' });
  assert.equal(db.events.length, 1);

  await workflow.saveDraftContent(created._id, reporter, { title: 'V2', baseVersion: 0 });
  await workflow.submitForApproval(created._id, reporter);
  const updatedArticle = await workflow.approve(created._id, editor);
  assert.equal(updatedArticle.published.title, 'V2');
  assert.equal(db.events.length, 2);
  assert.equal(db.events[1].kind, 'update');
  assert.equal(new Date(updatedArticle.publishedAt).getTime(), new Date(published.publishedAt).getTime());
});

test('deleteArticle cascades Comments, PublicationEvents, and ViewStatistics before the Article, and is Editor-only', async t => {
  const db = makeDb();
  const calls = [];
  installMocks(t, db, calls);
  const reporter = { id: newId(), role: ROLES.REPORTER };
  const editor = { id: newId(), role: ROLES.EDITOR };
  const created = await workflow.createDraft(reporter);

  await assert.rejects(workflow.deleteArticle(created._id, reporter), { code: 'FORBIDDEN' });
  await assert.rejects(workflow.deleteArticle(newId(), editor), { code: 'NOT_FOUND' });

  await workflow.deleteArticle(created._id, editor);
  assert.deepEqual(calls, ['comments', 'publicationEvents', 'viewStatistics', 'article']);
  assert.equal(db.articles.some(a => a._id === created._id), false);
});
