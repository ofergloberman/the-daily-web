const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Session = require('../models/Session');
const workflow = require('../models/articleWorkflow');
const { hashToken } = require('../middleware/auth');

const { ObjectId } = mongoose.Types;
const { WorkflowError } = workflow;

const tokens = { editor: 'e'.repeat(64), reporter: 'c'.repeat(64) };
const editorUser = { _id: new ObjectId(), id: String(new ObjectId()), displayName: 'Eli Editor', role: 'editor' };
const reporterUser = { _id: new ObjectId(), id: String(new ObjectId()), displayName: 'Rina Reporter', role: 'reporter' };

async function startServer(t) {
  const users = new Map([[hashToken(tokens.editor), editorUser], [hashToken(tokens.reporter), reporterUser]]);
  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));
  t.mock.method(console, 'info', () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const send = (method, path, token, body) => fetch(base + path, {
    method,
    headers: { Origin: base, ...(token && { Cookie: `wd_session=${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  send.base = base;
  return send;
}

function mockWorkflow(t, name, impl) {
  return t.mock.method(workflow, name, impl);
}

const ACTIONS = [
  { name: 'approve', method: 'POST', path: id => `/editor/articles/${id}/approve`, body: undefined },
  { name: 'returnForCorrections', method: 'POST', path: id => `/editor/articles/${id}/return`, body: { note: 'Add a source.' } },
  { name: 'editAsEditor', method: 'PATCH', path: id => `/editor/articles/${id}`, body: { title: 'New title' } },
  { name: 'deleteArticle', method: 'DELETE', path: id => `/editor/articles/${id}`, body: undefined }
];

test('every Editor action rejects guests and Reporters before reaching the workflow', async t => {
  const send = await startServer(t);
  const spies = ACTIONS.map(action => mockWorkflow(t, action.name, async () => { throw new Error('must not run'); }));
  const id = new ObjectId();
  for (const action of ACTIONS) {
    const guest = await send(action.method, action.path(id), undefined, action.body);
    assert.equal(guest.status, 401, `${action.name} as guest`);
    const reporter = await send(action.method, action.path(id), tokens.reporter, action.body);
    assert.equal(reporter.status, 403, `${action.name} as reporter`);
  }
  assert.ok(spies.every(spy => spy.mock.callCount() === 0));
});

test('Editor actions are rejected without a same-origin Origin header', async t => {
  const send = await startServer(t);
  t.mock.method(console, 'warn', () => {});
  const spies = ACTIONS.map(action => mockWorkflow(t, action.name, async () => { throw new Error('must not run'); }));
  const id = new ObjectId();
  for (const action of ACTIONS) {
    for (const origin of [undefined, 'https://evil.example']) {
      const response = await fetch(send.base + action.path(id), {
        method: action.method, headers: { Cookie: `wd_session=${tokens.editor}`, ...(origin && { Origin: origin }) }
      });
      assert.equal(response.status, 403, `${action.name} with origin ${origin}`);
      assert.equal((await response.json()).error, 'CSRF_REJECTED');
    }
  }
  assert.ok(spies.every(spy => spy.mock.callCount() === 0));
});

test('approve publishes through the workflow as the signed-in Editor', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  const approve = mockWorkflow(t, 'approve', async articleId => ({ _id: articleId, status: 'published' }));
  const response = await send('POST', `/editor/articles/${id}/approve`, tokens.editor);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: String(id), status: 'published' } });
  assert.deepEqual(approve.mock.calls[0].arguments, [String(id), { id: editorUser.id, role: 'editor' }]);
});

test('return passes the correction note and reports the new status', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  const giveBack = mockWorkflow(t, 'returnForCorrections', async articleId => ({ _id: articleId, status: 'returned' }));
  const response = await send('POST', `/editor/articles/${id}/return`, tokens.editor, { note: 'Add a source.' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: String(id), status: 'returned' } });
  assert.deepEqual(giveBack.mock.calls[0].arguments, [String(id), { id: editorUser.id, role: 'editor' }, 'Add a source.']);
});

test('return without a usable note is rejected with 400 NOTE_REQUIRED', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  for (const body of [undefined, {}, { note: '   ' }, { note: 42 }]) {
    const response = await send('POST', `/editor/articles/${id}/return`, tokens.editor, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, 'NOTE_REQUIRED');
  }
});

test('edit sends only the request body to the workflow and returns the new version state', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  const edit = mockWorkflow(t, 'editAsEditor', async articleId => ({ _id: articleId, status: 'pending' }));
  const content = { title: 'New title', body: 'Fixed text' };
  const response = await send('PATCH', `/editor/articles/${id}`, tokens.editor, content);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: String(id), status: 'pending' } });
  assert.deepEqual(edit.mock.calls[0].arguments, [String(id), { id: editorUser.id, role: 'editor' }, content]);
});

test('edit rejects missing, non-object and non-string content with 400 INVALID_CONTENT', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  for (const body of [undefined, [], { title: 5 }, { body: 'x'.repeat(50001) }]) {
    const response = await send('PATCH', `/editor/articles/${id}`, tokens.editor, body);
    assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 40));
    assert.equal((await response.json()).error, 'INVALID_CONTENT');
  }
});

test('delete removes the article through the workflow', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  const remove = mockWorkflow(t, 'deleteArticle', async () => {});
  const response = await send('DELETE', `/editor/articles/${id}`, tokens.editor);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: String(id) } });
  assert.deepEqual(remove.mock.calls[0].arguments, [String(id), { id: editorUser.id, role: 'editor' }]);
});

test('a malformed article id returns 404 NOT_FOUND for every action', async t => {
  const send = await startServer(t);
  for (const action of ACTIONS) {
    const response = await send(action.method, action.path('not-an-id'), tokens.editor, action.body);
    assert.equal(response.status, 404, action.name);
    assert.equal((await response.json()).error, 'NOT_FOUND');
  }
});

test('workflow errors keep their status and code, including an invalid state', async t => {
  const send = await startServer(t);
  const id = new ObjectId();
  mockWorkflow(t, 'approve', async () => { throw new WorkflowError('INVALID_TRANSITION', 'Cannot move an article from "draft" to "published".'); });
  mockWorkflow(t, 'deleteArticle', async () => { throw new WorkflowError('NOT_FOUND', 'Article not found.'); });
  const conflict = await send('POST', `/editor/articles/${id}/approve`, tokens.editor);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'INVALID_TRANSITION', message: 'Cannot move an article from "draft" to "published".' });
  const missing = await send('DELETE', `/editor/articles/${id}`, tokens.editor);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'NOT_FOUND');
});

test('an unexpected failure returns a generic 500 without leaking details', async t => {
  const send = await startServer(t);
  t.mock.method(console, 'error', () => {});
  mockWorkflow(t, 'approve', async () => { throw new Error('connect ECONNREFUSED db.internal:27017'); });
  const response = await send('POST', `/editor/articles/${new ObjectId()}/approve`, tokens.editor);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: 'INTERNAL_SERVER_ERROR' });
  assert.doesNotMatch(text, /ECONNREFUSED|db\.internal/);
});

function reviewArticle(status) {
  return {
    _id: new ObjectId(), author: { displayName: 'Dana' }, status, editorNote: '',
    updatedAt: new Date('2026-10-02T10:00:00Z'), lastPublishedAt: null, published: null,
    draft: { title: 'Draft "headline"', summary: 'Sum', body: 'Body <b>text</b>', category: 'World', imageUrl: '' }
  };
}

async function reviewHtml(t, send, status) {
  const article = reviewArticle(status);
  t.mock.method(Article, 'findById', () => ({ populate() { return this; }, async lean() { return article; } }));
  const response = await send('GET', `/editor/articles/${article._id}`, tokens.editor);
  assert.equal(response.status, 200);
  return response.text();
}

test('review page offers approve and return only while the article is pending', async t => {
  const send = await startServer(t);
  const pending = await reviewHtml(t, send, 'pending');
  assert.match(pending, /data-action="approve"/);
  assert.match(pending, /data-action="return"/);
  assert.match(pending, /id="return-note"[^>]*maxlength="2000"/);
  assert.match(pending, /<script src="\/editor-actions\.js"/);

  for (const status of ['draft', 'published', 'returned']) {
    const html = await reviewHtml(t, send, status);
    assert.doesNotMatch(html, /data-action="approve"/, status);
    assert.doesNotMatch(html, /data-action="return"/, status);
    assert.match(html, /data-action="delete"/, status);
    assert.match(html, /id="edit-form"/, status);
  }
});

test('the edit form is prefilled with the escaped working copy', async t => {
  const send = await startServer(t);
  const html = await reviewHtml(t, send, 'pending');
  assert.match(html, /name="title"[^>]*value="Draft &#34;headline&#34;"/);
  assert.match(html, /Body &lt;b&gt;text&lt;\/b&gt;<\/textarea>/);
});
