// Phase E hardening: error pages vs JSON, the authorization and invalid-input matrices, outage and logging behaviour,
// and the failure paths of the three Developer 4 browser scripts. No database is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const Session = require('../models/Session');
const ViewedArticle = require('../models/ViewedArticle');
const workflow = require('../models/articleWorkflow');
const analytics = require('../models/analyticsOperations');
const visits = require('../services/visits');
const database = require('../config/database');
const explainDev4 = require('../scripts/explainDev4');
const { summarize, timed } = require('../scripts/explainSummary');
const { deskListQuery, editorDeskFilter } = require('../models/editorArticleQueries');
const { hashToken } = require('../middleware/auth');
const { sendError } = require('../helpers/sendError');
const { EDITOR_SEARCH_MAX_LENGTH, EDITOR_NOTE_MAX_LENGTH } = require('../config/constants');
const { stubConnected, stubDisconnected } = require('./connectionState');

const { ObjectId } = mongoose.Types;
const { WorkflowError } = workflow;

const JSON_ACCEPT = 'application/json';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';
const BODY_LIMIT_BYTES = 100 * 1024;
const MESSAGE_SENTINEL = 'mongodb://dbuser:pa55word@db.example/the_daily_web';
const tokens = { editor: 'e'.repeat(64), reporter: 'c'.repeat(64) };
const editorUser = { _id: new ObjectId(), id: String(new ObjectId()), displayName: 'Eli Editor', role: 'editor' };
const reporterUser = { _id: new ObjectId(), id: String(new ObjectId()), displayName: 'Rina Reporter', role: 'reporter' };
const ARTICLE_ID = String(new ObjectId());

async function startServer(t) {
  const users = new Map([[hashToken(tokens.editor), editorUser], [hashToken(tokens.reporter), reporterUser]]);
  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));
  const info = t.mock.method(console, 'info', () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  // Same-origin Origin header, as a browser sends it, so unsafe methods reach the auth checks.
  const send = (method, url, { token, accept = JSON_ACCEPT, body, rawBody } = {}) => fetch(base + url, {
    method,
    redirect: 'manual',
    headers: {
      Origin: base, Accept: accept,
      ...(token && { Cookie: `wd_session=${token}` }),
      ...((body !== undefined || rawBody !== undefined) && { 'Content-Type': 'application/json' })
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  });
  send.info = info;
  return send;
}

function queryDouble(rows) {
  return {
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, populate() { return this; },
    async lean() { return rows; }
  };
}

function articleOnlyQuery(row) {
  return { select() { return this; }, async lean() { return row; } };
}

const WORKFLOW_ACTIONS = ['approve', 'returnForCorrections', 'editAsEditor', 'deleteArticle'];

// Every model entry point a Developer 4 route could reach; none may run for a rejected request.
function forbidDatabase(t) {
  const spies = ['find', 'findById', 'findOne'].map(name => t.mock.method(Article, name, () => { throw new Error('must not run'); }));
  WORKFLOW_ACTIONS.forEach(name => spies.push(t.mock.method(workflow, name, async () => { throw new Error('must not run'); })));
  return () => spies.reduce((total, spy) => total + spy.mock.callCount(), 0);
}

const ROUTES = [
  { method: 'GET', url: () => '/editor' },
  { method: 'GET', url: () => '/editor/articles' },
  { method: 'GET', url: id => `/editor/articles/${id}` },
  { method: 'PATCH', url: id => `/editor/articles/${id}`, body: { title: 'New title' } },
  { method: 'DELETE', url: id => `/editor/articles/${id}` },
  { method: 'POST', url: id => `/editor/articles/${id}/approve` },
  { method: 'POST', url: id => `/editor/articles/${id}/return`, body: { note: 'Add a source.' } },
  { method: 'GET', url: () => '/analytics' },
  { method: 'GET', url: () => '/analytics/articles' },
  { method: 'GET', url: id => `/analytics/articles/${id}/views` }
];
const ARTICLE_ROUTES = ROUTES.filter(route => route.url('x').startsWith('/editor/articles/'));

// A request that still succeeds after the bad ones proves the server did not crash or keep state.
async function assertServerStillAnswers(send) {
  const desk = await send('GET', '/editor/articles', { token: tokens.editor });
  assert.equal(desk.status, 200);
  assert.deepEqual((await desk.json()).data, { articles: [], page: 1, hasNext: false });
}

test('sendError renders the error page for a browser page request and JSON for everything else', () => {
  function respond(method, accepted) {
    const sent = {};
    const res = {
      status(code) { sent.status = code; return this; },
      render(view, locals) { sent.view = view; sent.locals = locals; },
      json(body) { sent.json = body; }
    };
    sendError({ method, accepts: () => accepted, user: undefined }, res, 403, 'FORBIDDEN', 'Not for you.');
    return sent;
  }
  const page = respond('GET', 'html');
  assert.equal(page.status, 403);
  assert.equal(page.view, 'error');
  assert.equal(page.locals.message, 'Not for you.');
  assert.equal(page.locals.title, 'Access denied');
  assert.deepEqual([page.locals.linkHref, page.locals.linkText], ['/', 'Back to the latest news']);
  assert.equal(page.json, undefined);

  for (const [method, accepted] of [['GET', 'json'], ['GET', false], ['POST', 'html'], ['PATCH', 'html'], ['DELETE', 'html']]) {
    const sent = respond(method, accepted);
    assert.equal(sent.status, 403, `${method} ${accepted}`);
    assert.deepEqual(sent.json, { error: 'FORBIDDEN', message: 'Not for you.' }, `${method} ${accepted}`);
    assert.equal(sent.view, undefined);
  }
});

test('sendError uses the link it is given and a generic title for an unlisted status', () => {
  const sent = {};
  const res = { status(code) { sent.status = code; return this; }, render(view, locals) { sent.locals = locals; } };
  sendError({ method: 'GET', accepts: () => 'html' }, res, 418, 'TEAPOT', 'No.', { href: '/editor', text: 'Back to the Editor desk' });
  assert.equal(sent.locals.title, 'Something went wrong');
  assert.deepEqual([sent.locals.linkHref, sent.locals.linkText], ['/editor', 'Back to the Editor desk']);
});

test('an unknown address is an HTML page for a browser and a JSON body with a message for fetch', async t => {
  const send = await startServer(t);
  const page = await send('GET', '/no-such-page', { accept: HTML_ACCEPT });
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Page not found/);

  const data = await send('GET', '/no-such-page');
  assert.equal(data.status, 404);
  assert.deepEqual(await data.json(), { error: 'NOT_FOUND', message: 'This page does not exist or is no longer available.' });

  const unsafe = await send('POST', '/no-such-page', { accept: HTML_ACCEPT });
  assert.equal(unsafe.status, 404);
  assert.equal((await unsafe.json()).error, 'NOT_FOUND');
});

test('guests get a 401 with a message from fetch and a 303 to /auth for a browser page, on every Developer 4 route', async t => {
  const send = await startServer(t);
  const databaseCalls = forbidDatabase(t);
  for (const route of ROUTES) {
    const label = `${route.method} ${route.url(ARTICLE_ID)}`;
    const fetched = await send(route.method, route.url(ARTICLE_ID), { body: route.body });
    assert.equal(fetched.status, 401, label);
    const body = await fetched.json();
    assert.equal(body.error, 'AUTH_REQUIRED', label);
    assert.equal(body.message, 'Sign in to continue.', label);

    const browser = await send(route.method, route.url(ARTICLE_ID), { accept: HTML_ACCEPT, body: route.body });
    if (route.method === 'GET') {
      assert.equal(browser.status, 303, label);
      assert.equal(browser.headers.get('location'), '/auth', label);
    } else {
      assert.equal(browser.status, 401, `${label} (not a page request)`);
      assert.equal((await browser.json()).error, 'AUTH_REQUIRED', label);
    }
  }
  assert.equal(databaseCalls(), 0);
});

test('Reporters get a 403 page for a browser page request and JSON otherwise, on every Developer 4 route', async t => {
  const send = await startServer(t);
  const databaseCalls = forbidDatabase(t);
  for (const route of ROUTES) {
    const label = `${route.method} ${route.url(ARTICLE_ID)}`;
    const fetched = await send(route.method, route.url(ARTICLE_ID), { token: tokens.reporter, body: route.body });
    assert.equal(fetched.status, 403, label);
    assert.deepEqual(await fetched.json(), { error: 'FORBIDDEN', message: 'Your account cannot open this area.' }, label);

    const browser = await send(route.method, route.url(ARTICLE_ID), { token: tokens.reporter, accept: HTML_ACCEPT, body: route.body });
    assert.equal(browser.status, 403, label);
    if (route.method === 'GET') {
      assert.match(browser.headers.get('content-type'), /text\/html/, label);
      const html = await browser.text();
      assert.match(html, /Access denied/, label);
      assert.match(html, /Your account cannot open this area\./, label);
    } else {
      assert.equal((await browser.json()).error, 'FORBIDDEN', label);
    }
  }
  assert.equal(databaseCalls(), 0);
});

test('the Editor desk JSON route rejects bad query values with 400 and keeps working', async t => {
  const send = await startServer(t);
  const databaseCalls = forbidDatabase(t);
  const cases = [
    ['?q=a&q=b', 'INVALID_SEARCH'],
    ['?status=a&status=b', 'INVALID_STATUS'],
    ['?status=nope', 'INVALID_STATUS'],
    [`?q=${'x'.repeat(EDITOR_SEARCH_MAX_LENGTH + 1)}`, 'INVALID_SEARCH'],
    ['?page=abc', 'INVALID_PAGE'],
    ['?page=0', 'INVALID_PAGE'],
    ['?page=1&page=2', 'INVALID_PAGE']
  ];
  for (const [query, code] of cases) {
    const response = await send('GET', `/editor/articles${query}`, { token: tokens.editor });
    const body = await response.json();
    assert.equal(response.status, 400, query);
    assert.equal(body.error, code, query);
    assert.equal(typeof body.message, 'string', query);
  }
  assert.equal(databaseCalls(), 0);
  Article.find.mock.mockImplementation(() => queryDouble([]));
  await assertServerStillAnswers(send);
});

test('/editor?page=abc is a 400 page with a link back to the desk, while /editor/articles?page=abc stays JSON', async t => {
  const send = await startServer(t);
  const databaseCalls = forbidDatabase(t);
  for (const query of ['?page=abc', '?status=nope', '?q=a&q=b']) {
    const page = await send('GET', `/editor${query}`, { token: tokens.editor, accept: HTML_ACCEPT });
    assert.equal(page.status, 400, query);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<a href="\/editor">Back to the Editor desk<\/a>/, query);
  }
  const data = await send('GET', '/editor/articles?page=abc', { token: tokens.editor, accept: HTML_ACCEPT });
  assert.equal(data.status, 400);
  assert.equal((await data.json()).error, 'INVALID_PAGE');
  assert.equal(databaseCalls(), 0);
});

test('malformed ids are 404 for the review page and every Editor action, and a valid unknown id is 404 too', async t => {
  const send = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([]));
  for (const id of ['abc', 'a'.repeat(23), 'a'.repeat(25)]) {
    for (const route of ARTICLE_ROUTES) {
      const response = await send(route.method, route.url(id), { token: tokens.editor, body: route.body });
      assert.equal(response.status, 404, `${route.method} id of ${id.length} characters`);
    }
  }

  t.mock.method(Article, 'findById', () => ({ populate() { return this; }, async lean() { return null; } }));
  const missing = await send('GET', `/editor/articles/${ARTICLE_ID}`, { token: tokens.editor, accept: HTML_ACCEPT });
  assert.equal(missing.status, 404);
  WORKFLOW_ACTIONS.forEach(name => t.mock.method(workflow, name, async () => { throw new WorkflowError('NOT_FOUND', 'Article not found.'); }));
  for (const route of ARTICLE_ROUTES.filter(entry => entry.method !== 'GET')) {
    const response = await send(route.method, route.url(ARTICLE_ID), { token: tokens.editor, body: route.body });
    assert.equal(response.status, 404, `${route.method} ${route.url(ARTICLE_ID)}`);
    assert.equal((await response.json()).error, 'NOT_FOUND');
  }
  await assertServerStillAnswers(send);
});

test('an address with a broken percent sequence is a 400, not a crash', async t => {
  const send = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([]));
  const response = await send('GET', '/editor/articles/%zz', { token: tokens.editor });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'BAD_REQUEST', message: 'The request could not be understood.' });
  await assertServerStillAnswers(send);
});

test('analytics rejects bad ids, array params, long searches and bad ranges with 400 and keeps working', async t => {
  const send = await startServer(t);
  const databaseCalls = forbidDatabase(t);
  const to = new Date('2026-10-16T00:00:00.000Z');
  const tooLongFrom = new Date(to.getTime() - analytics.MAX_RANGE_MS - 1);
  const range = (from, end) => `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
  const viewsUrl = (query = '') => `/analytics/articles/${ARTICLE_ID}/views${query}`;
  const cases = [
    ['/analytics/articles?q=a&q=b', 'INVALID_QUERY'],
    ['/analytics/articles?sort=a&sort=b', 'INVALID_QUERY'],
    ['/analytics/articles?sort=nope', 'INVALID_QUERY'],
    [`/analytics/articles?q=${'x'.repeat(EDITOR_SEARCH_MAX_LENGTH + 1)}`, 'INVALID_QUERY'],
    ...['abc', 'a'.repeat(23), 'a'.repeat(25)].map(id => [`/analytics/articles/${id}/views`, 'INVALID_ARTICLE_ID']),
    [viewsUrl('?from=a&from=b'), 'INVALID_RANGE'],
    [viewsUrl('?to=a&to=b'), 'INVALID_RANGE'],
    [viewsUrl(range(to, new Date(to.getTime() - 1000))), 'INVALID_RANGE'],
    [viewsUrl(range(tooLongFrom, to)), 'INVALID_RANGE'],
    [viewsUrl('?from=not-a-date'), 'INVALID_RANGE']
  ];
  for (const [url, code] of cases) {
    const response = await send('GET', url, { token: tokens.editor });
    const body = await response.json();
    assert.equal(response.status, 400, url);
    assert.equal(body.error, code, url);
    assert.equal(typeof body.message, 'string', url);
  }
  assert.equal(databaseCalls(), 0);

  const tooLong = await (await send('GET', viewsUrl(range(tooLongFrom, to)), { token: tokens.editor })).json();
  assert.match(tooLong.message, new RegExp(`at most ${analytics.MAX_RANGE_MS / analytics.DAY_MS} days`));

  Article.findOne.mock.mockImplementation(() => articleOnlyQuery(null));
  const unknown = await send('GET', viewsUrl(), { token: tokens.editor });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'ARTICLE_NOT_FOUND');
  Article.find.mock.mockImplementation(() => queryDouble([]));
  const search = await send('GET', '/analytics/articles', { token: tokens.editor });
  assert.deepEqual(await search.json(), { data: [] });
});

test('action bodies: non-string note, over-long note, malformed JSON and an oversized body are 4xx and the server keeps working', async t => {
  const send = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([]));
  const returnUrl = `/editor/articles/${ARTICLE_ID}/return`;
  const editUrl = `/editor/articles/${ARTICLE_ID}`;

  for (const note of [42, null, ['x'], { text: 'x' }]) {
    const response = await send('POST', returnUrl, { token: tokens.editor, body: { note } });
    assert.equal(response.status, 400, JSON.stringify(note));
    assert.equal((await response.json()).error, 'NOTE_REQUIRED');
  }

  // The schema enforces the note length when the workflow writes, so the stubbed write validates the same way.
  t.mock.method(Article, 'findById', async () => ({ status: 'pending' }));
  t.mock.method(Article, 'findOneAndUpdate', async (_filter, update) => {
    const draft = new Article();
    draft.set('editorNote', update.$set.editorNote);
    await draft.validate(['editorNote']);
  });
  const long = await send('POST', returnUrl, { token: tokens.editor, body: { note: 'x'.repeat(EDITOR_NOTE_MAX_LENGTH + 1) } });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error, 'INVALID_CONTENT');

  const malformed = await send('PATCH', editUrl, { token: tokens.editor, rawBody: '{"title":' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'INVALID_JSON', message: 'The request body is not valid JSON.' });

  const oversized = await send('PATCH', editUrl, { token: tokens.editor, body: { body: 'x'.repeat(BODY_LIMIT_BYTES + 1) } });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' });

  await assertServerStillAnswers(send);
});

test('an unsupported charset or content encoding is a 415 client error, not a server failure, and is not logged as one', async t => {
  const send = await startServer(t);
  stubConnected(t);
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(Article, 'find', () => queryDouble([]));
  const editUrl = `/editor/articles/${ARTICLE_ID}`;
  const body = JSON.stringify({ title: 'x' });
  const base = process.env.APP_ORIGIN;
  const headers = extra => ({ Origin: base, Accept: JSON_ACCEPT, Cookie: `wd_session=${tokens.editor}`, ...extra });

  const charset = await fetch(base + editUrl, { method: 'PATCH', headers: headers({ 'Content-Type': 'application/json; charset=latin1' }), body });
  assert.equal(charset.status, 415);
  assert.deepEqual(await charset.json(), { error: 'BAD_REQUEST', message: 'The request could not be understood.' });

  const encoding = await fetch(base + editUrl, { method: 'PATCH', headers: headers({ 'Content-Type': 'application/json', 'Content-Encoding': 'unknown' }), body });
  assert.equal(encoding.status, 415);
  assert.equal((await encoding.json()).error, 'BAD_REQUEST');

  assert.equal(errors.mock.callCount(), 0, 'a client mistake is not a failed request');
  await assertServerStillAnswers(send);
});

test('a failing query is a 500 with an error and a message, as JSON for fetch and as a page for a browser', async t => {
  const send = await startServer(t);
  stubConnected(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(Article, 'find', () => { throw new Error('query exploded'); });
  const failed = await send('GET', '/editor/articles', { token: tokens.editor });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Try again.' });

  const page = await send('GET', '/editor', { token: tokens.editor, accept: HTML_ACCEPT });
  assert.equal(page.status, 500);
  const html = await page.text();
  assert.match(html, /Something went wrong\. Try again\./);
  assert.doesNotMatch(html, /query exploded/);
});

test('with the database disconnected a failing request is a 503 DATABASE_UNAVAILABLE', async t => {
  const send = await startServer(t);
  stubDisconnected(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(Article, 'find', () => { throw new Error('buffering timed out'); });
  const failed = await send('GET', '/editor/articles', { token: tokens.editor });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: 'DATABASE_UNAVAILABLE', message: 'The service is temporarily unavailable. Try again in a moment.'
  });

  const page = await send('GET', '/editor', { token: tokens.editor, accept: HTML_ACCEPT });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /temporarily unavailable/);

  const malformed = await send('PATCH', `/editor/articles/${ARTICLE_ID}`, { token: tokens.editor, rawBody: '{' });
  assert.equal(malformed.status, 400, 'a client mistake stays a 4xx during an outage');
});

test('failures are logged with method, path and status only, never cookies, query strings, bodies or the database URI', async t => {
  const send = await startServer(t);
  stubConnected(t);
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(Article, 'find', () => { throw new Error(MESSAGE_SENTINEL); });
  t.mock.method(workflow, 'returnForCorrections', async () => { throw new Error(MESSAGE_SENTINEL); });

  await send('GET', '/editor/articles?q=hunter2', { token: tokens.editor });
  await send('POST', `/editor/articles/${ARTICLE_ID}/return`, { token: tokens.editor, body: { note: 'private-note-text', password: 'letmein' } });

  assert.deepEqual(errors.mock.calls.map(call => call.arguments), [
    ['Request failed:', 'GET', '/editor/articles', 500, 'Error'],
    ['Request failed:', 'POST', `/editor/articles/${ARTICLE_ID}/return`, 500, 'Error']
  ]);
  const logged = JSON.stringify(errors.mock.calls.map(call => call.arguments));
  for (const secret of [tokens.editor, 'wd_session', 'hunter2', 'private-note-text', 'letmein', 'mongodb://', 'pa55word', 'dbuser']) {
    assert.ok(!logged.includes(secret), `the log must not contain ${secret}`);
  }
});

test('an Editor action is logged with the Editor id and the article id but not the note', async t => {
  const send = await startServer(t);
  t.mock.method(workflow, 'returnForCorrections', async articleId => ({ _id: articleId, status: 'returned' }));
  const response = await send('POST', `/editor/articles/${ARTICLE_ID}/return`, { token: tokens.editor, body: { note: 'private-note-text' } });
  assert.equal(response.status, 200);
  assert.deepEqual(send.info.mock.calls.map(call => call.arguments), [[`Editor returned article: editor ${editorUser.id}, article ${ARTICLE_ID}`]]);
});

test('a rejected or throwing visit recording is logged by name and never becomes an unhandled rejection', async t => {
  const send = await startServer(t);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const article = { _id: new ObjectId(), author: { displayName: 'Dana' }, published: { title: 'Still readable', body: 'Body.' } };
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, populate() { return this; }, async lean() { return article; } }));
  t.mock.method(Comment, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return []; } }));
  t.mock.method(ViewedArticle, 'markViewed', async () => {});
  const record = t.mock.method(visits, 'recordVisit', async () => { throw new Error(MESSAGE_SENTINEL); });
  const errors = t.mock.method(console, 'error', () => {});

  assert.equal((await send('GET', `/articles/${article._id}`)).status, 200);
  record.mock.mockImplementation(() => { throw new Error(MESSAGE_SENTINEL); });
  assert.equal((await send('GET', `/articles/${article._id}`)).status, 200);
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(errors.mock.calls.map(call => call.arguments), [['Visit not recorded:', 'Error'], ['Visit not recorded:', 'Error']]);
  assert.deepEqual(unhandled, []);
});

test('the database connection waits at most the named timeouts and logs each outage and recovery without the URI', async t => {
  assert.equal(database.SERVER_SELECTION_TIMEOUT_MS, 5000);
  assert.equal(database.DB_BUFFER_TIMEOUT_MS, 5000);

  const connect = t.mock.method(mongoose, 'connect', async () => { throw new Error('stop after connect'); });
  await assert.rejects(database.connectDatabase('mongodb://user:secret@host/the_daily_web'), /stop after connect/);
  assert.deepEqual(connect.mock.calls[0].arguments[1], { serverSelectionTimeoutMS: 5000, bufferTimeoutMS: 5000 });

  const connection = new EventEmitter();
  const warn = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  database.logConnectionEvents(connection);
  connection.emit('disconnected');
  connection.emit('reconnected');
  connection.emit('disconnected');
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [['MongoDB disconnected'], ['MongoDB disconnected']]);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [['MongoDB reconnected']]);
});

// ---- browser scripts: failure paths -------------------------------------------------------------

const readScript = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const SERVER_FORBIDDEN_MESSAGE = 'Your account cannot open this area.';

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const unreadable = status => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });

// What each script must do when its request fails.
const FAILURES = [
  { name: 'an unreachable server', answer: () => { throw new TypeError('Failed to fetch'); }, message: /could not be reached/, signIn: false },
  { name: 'a proxy 502 with an HTML body', answer: () => unreadable(502), message: /Try again/, signIn: false },
  { name: 'an ended session (401)', answer: () => reply(401, { error: 'AUTH_REQUIRED', message: 'Sign in to continue.' }), message: /session has ended/, signIn: true },
  { name: 'a forbidden account (403)', answer: () => reply(403, { error: 'FORBIDDEN', message: SERVER_FORBIDDEN_MESSAGE }), message: /cannot open this area/, signIn: false }
];

const flush = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)); };

function element(extra = {}) {
  const listeners = {};
  return {
    dataset: {}, children: [], attrs: {}, hidden: false, textContent: '', className: '', value: '', href: '', disabled: false,
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelectorAll: () => [],
    addEventListener(type, callback) { listeners[type] = callback; },
    fire(type, event = {}) { return listeners[type]?.({ preventDefault() {}, ...event }); },
    ...extra
  };
}

function deskPage(answer) {
  const els = Object.fromEntries(['desk-search', 'desk-q', 'desk-clear', 'desk-filter', 'desk-list', 'desk-pager', 'desk-status', 'desk-signin']
    .map(id => [id, element()]));
  els['desk-signin'].hidden = true;
  const calls = [];
  const context = {
    document: { getElementById: id => els[id], createElement: () => element(), addEventListener() {} },
    fetch: async (url, options = {}) => { calls.push({ url, accept: options.headers?.Accept }); return answer(url); },
    history: { replaceState() {} }, location: { search: '' },
    AbortController, URLSearchParams, Error, TypeError, scrollTo() {}, setTimeout, clearTimeout
  };
  context.window = context;
  vm.runInNewContext(readScript('editor-desk.js'), context);
  return {
    els, calls,
    async search(text) { els['desk-q'].value = text; els['desk-search'].fire('submit'); await flush(); }
  };
}

function actionsPage(answer) {
  const buttons = [element(), element()];
  const els = {
    review: element({ dataset: { articleId: 'abc123' }, querySelectorAll: () => buttons }),
    'action-status': element({ hidden: true }), 'action-signin': element({ hidden: true }),
    'return-note': element(), 'review-content': element({ replaceWith() { this.replaced = true; } })
  };
  const calls = [];
  const location = { reloaded: false, assign() {}, reload() { this.reloaded = true; } };
  const context = {
    TypeError, document: { getElementById: id => els[id] },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', accept: options.headers?.Accept, buttonsDisabled: buttons.every(button => button.disabled) });
      return answer(url);
    },
    DOMParser: class { parseFromString() { return { getElementById: () => ({}) }; } },
    FormData: class { constructor(form) { this.fields = form.fields; } [Symbol.iterator]() { return Object.entries(this.fields)[Symbol.iterator](); } },
    window: { confirm: () => true, location }
  };
  vm.runInNewContext(readScript('editor-actions.js'), context);
  return {
    els, calls, buttons, location,
    async click(action) { els.review.fire('click', { target: { closest: () => ({ dataset: { action } }) } }); await flush(); },
    async submitEdit(fields) { els.review.fire('submit', { target: { id: 'edit-form', fields } }); await flush(); }
  };
}

function analyticsPage(answer) {
  const ids = ['article-search', 'article-sort', 'search-status', 'article-results', 'analytics-panel', 'chart-title', 'range', 'chart-status',
    'views-chart', 'versions-body', 'analytics-signin'];
  const els = Object.fromEntries(ids.map(id => [id, element()]));
  els.analytics = element({ dataset: { timeZone: 'UTC', articleId: ARTICLE_ID } });
  els['article-sort'].value = 'default';
  els['analytics-signin'].hidden = true;
  const calls = [];
  const context = {
    TypeError, Intl, setTimeout, clearTimeout, window: {}, history: { replaceState() {} }, ResizeObserver: class { observe() {} },
    document: { getElementById: id => els[id], createElement: () => element() },
    fetch: async (url, options = {}) => { calls.push({ url, accept: options.headers?.Accept }); return answer(url); }
  };
  vm.runInNewContext(readScript('analytics.js'), context);
  return { els, calls };
}

for (const failure of FAILURES) {
  test(`Editor desk: ${failure.name} shows a message, clears the busy flag and keeps the typed search`, async () => {
    const view = deskPage(failure.answer);
    await view.search('united');
    assert.match(view.els['desk-status'].textContent, failure.message);
    assert.match(view.els['desk-status'].className, /notice-error/);
    assert.equal(view.els['desk-signin'].hidden, !failure.signIn);
    assert.equal(view.els['desk-list'].attrs['aria-busy'], undefined);
    assert.equal(view.els['desk-q'].value, 'united');
    assert.ok(view.calls.every(call => call.accept === JSON_ACCEPT), 'every request asks for JSON');
  });

  test(`Review actions: ${failure.name} shows a message, unlocks the buttons and keeps the note and edits`, async () => {
    const view = actionsPage(failure.answer);
    view.els['return-note'].value = 'Add a second source.';
    await view.click('approve');
    await view.click('return');
    await view.submitEdit({ title: 'My edit' });
    const status = view.els['action-status'];
    assert.match(status.textContent, failure.message);
    assert.equal(status.className, 'notice notice-error');
    assert.equal(status.hidden, false);
    assert.equal(view.els['action-signin'].hidden, !failure.signIn);
    assert.equal(view.calls.length, 3, 'each failed action sent one request and no refresh');
    assert.ok(view.calls.every(call => call.buttonsDisabled), 'the buttons were locked during the request');
    assert.ok(view.buttons.every(button => !button.disabled), 'the buttons are unlocked again');
    assert.equal(view.els['return-note'].value, 'Add a second source.');
    assert.ok(!view.els['review-content'].replaced, 'the form is not replaced, so the edits stay');
    assert.equal(view.location.reloaded, false);
    assert.ok(view.calls.every(call => call.accept === JSON_ACCEPT), 'every request asks for JSON');
  });

  test(`Analytics: ${failure.name} shows a message for the search and the graph`, async () => {
    const view = analyticsPage(failure.answer);
    await flush();
    assert.match(view.els['search-status'].textContent, failure.message);
    assert.match(view.els['chart-status'].textContent, failure.message);
    assert.equal(view.els['analytics-signin'].hidden, !failure.signIn);
    assert.equal(view.calls.length, 2);
    assert.ok(view.calls.every(call => call.accept === JSON_ACCEPT), 'every request asks for JSON');
  });
}

test('a refresh after a successful action also asks for JSON, and the page is reloaded when it fails', async () => {
  const view = actionsPage(url => (url.endsWith('/approve') ? reply(200, { data: { id: 'abc123', status: 'published' } }) : unreadable(502)));
  await view.click('approve');
  assert.deepEqual(view.calls.map(call => [call.method, call.accept]), [['POST', JSON_ACCEPT], ['GET', JSON_ACCEPT]]);
  assert.equal(view.location.reloaded, true);
});

test('a JSON answer without data is treated as a failed request, not as success', async () => {
  const desk = deskPage(() => reply(200, {}));
  await desk.search('a');
  assert.match(desk.els['desk-status'].className, /notice-error/);
  const actions = actionsPage(() => reply(200, {}));
  await actions.click('approve');
  assert.equal(actions.els['action-status'].className, 'notice notice-error');
});

// ---- scripts/explainDev4.js: the pure helpers and the refusals that happen before any connection -----------

const DEMO_URI = 'mongodb://localhost:27018/the_daily_web_demo?replicaSet=rs0';

test('assertLocalBaseUrl accepts only localhost and 127.0.0.1', () => {
  assert.equal(explainDev4.assertLocalBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(explainDev4.assertLocalBaseUrl('http://127.0.0.1:4000/'), 'http://127.0.0.1:4000');
  for (const refused of ['http://example.com', 'http://localhost.evil.example', 'http://127.0.0.1@evil.example', 'http://192.168.1.5:3000', 'http://[::1]:3000']) {
    assert.throws(() => explainDev4.assertLocalBaseUrl(refused), /Refusing to send visits/, refused);
  }
  assert.throws(() => explainDev4.assertLocalBaseUrl('not a url'), /DEMO_BASE_URL must be a full address/);
});

test('the script refuses a non-demo database or a foreign host before it connects', async t => {
  const connect = t.mock.method(mongoose, 'connect', async () => {});
  await assert.rejects(explainDev4.main([], { MONGODB_URI: 'mongodb://localhost/the_daily_web' }),   /Refusing database/);
  await assert.rejects(explainDev4.main(['--visits'], { MONGODB_URI: DEMO_URI, DEMO_BASE_URL: 'http://example.com' }), /Refusing to send visits/);
  await assert.rejects(explainDev4.main([], {}), /Refusing/);
  assert.equal(connect.mock.callCount(), 0);
});

test('evaluateRows fails on a collection scan or a median above the limit, and only then', () => {
  const row = (overrides = {}) => ({ name: 'q', indexes: 'idx', collscans: 0, docs: 20, keys: 20, ms: 5, ...overrides });
  assert.deepEqual(explainDev4.evaluateRows([row(), row({ ms: explainDev4.SLOW_QUERY_MS })]), { passed: true, problems: [] });
  const scan = explainDev4.evaluateRows([row({ name: 'scan', collscans: 1 })]);
  assert.equal(scan.passed, false);
  assert.deepEqual(scan.problems, ['scan: collection scan']);
  const slow = explainDev4.evaluateRows([row({ name: 'slow', ms: explainDev4.SLOW_QUERY_MS + 1 })]);
  assert.equal(slow.passed, false);
  assert.match(slow.problems[0], /slow: 201 ms is above 200 ms/);
});

test('formatTable prints a Markdown table with the six documented columns', () => {
  const lines = explainDev4.formatTable([{ name: 'desk list: all, page 1', indexes: 'updatedAt_-1__id_-1', collscans: 0, docs: 21, keys: 21, ms: 4 }]);
  assert.deepEqual(lines, [
    '| query | indexes used | collection scans | docs read | keys read | ms |',
    '| --- | --- | --- | --- | --- | --- |',
    '| desk list: all, page 1 | updatedAt_-1__id_-1 | 0 | 21 | 21 | 4 |'
  ]);
});

test('checkVisitCounts compares the growth of both counters with the expected number', () => {
  const before = { totalViews: 500, bucketSum: 500 };
  const exact = explainDev4.checkVisitCounts({ before, after: { totalViews: 1500, bucketSum: 1500 }, expected: explainDev4.VISIT_REQUESTS });
  assert.ok(exact.every(item => item.ok));
  const lost = explainDev4.checkVisitCounts({ before, after: { totalViews: 1500, bucketSum: 1499 }, expected: explainDev4.VISIT_REQUESTS });
  assert.deepEqual(lost.map(item => item.ok), [true, false]);
  const headOnly = explainDev4.checkVisitCounts({ before, after: { totalViews: 501, bucketSum: 500 }, expected: 0 });
  assert.deepEqual(headOnly.map(item => item.ok), [false, true]);
  assert.match(explainDev4.formatChecks(lost).join('\n'), /sum of the view buckets \| 1000 \| 999 \| WRONG/);
});

test('runWithConcurrency runs every task once and never more than the limit at the same time', async () => {
  const seen = [];
  let running = 0;
  let peak = 0;
  await explainDev4.runWithConcurrency(120, 7, async index => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setImmediate(resolve));
    seen.push(index);
    running -= 1;
  });
  assert.equal(peak, 7);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 120 }, (_, index) => index));
  await explainDev4.runWithConcurrency(0, 7, async () => { throw new Error('must not run'); });
});

test('readUntil returns as soon as the answer is enough and the last answer when time runs out', async () => {
  let reads = 0;
  const growing = await explainDev4.readUntil(async () => ++reads, value => value >= 3, 1000, 1);
  assert.equal(growing, 3);
  const stuck = await explainDev4.readUntil(async () => 'same', () => false, 20, 5);
  assert.equal(stuck, 'same');
});

test('the visit URL is the public article address of the chosen article', () => {
  assert.equal(explainDev4.articleUrl('http://localhost:3000', ARTICLE_ID), `http://localhost:3000/articles/${ARTICLE_ID}`);
});

test('the explain script and the real desk query share one filter and one query builder', t => {
  const calls = {};
  t.mock.method(Article, 'find', filter => {
    calls.filter = filter;
    return { select() { return this; }, sort() { return this; }, skip(count) { calls.skip = count; return this; }, limit(count) { calls.limit = count; return this; } };
  });
  deskListQuery({ status: 'pending', q: 'united', page: 3, pageSize: 20 });
  assert.deepEqual(calls.filter, editorDeskFilter({ status: 'pending', q: 'united' }));
  assert.equal(calls.skip, 40);
  assert.equal(calls.limit, 21);
});

test('the view series pipeline matches one article and range first, and the bucket filter uses the visit minute', () => {
  const articleId = new ObjectId();
  const from = new Date('2026-10-01T00:00:00.000Z');
  const to = new Date('2026-10-08T00:00:00.000Z');
  const [match, facet] = analytics.viewSeriesPipeline(articleId, from, to, 'hour');
  assert.deepEqual(match, { $match: { article: articleId, minute: { $gte: from, $lt: to } } });
  assert.deepEqual(Object.keys(facet.$facet), ['series', 'byPublication', 'bucketPublications']);
  const publicationId = new ObjectId();
  assert.deepEqual(analytics.visitBucketFilter(articleId, publicationId, new Date('2026-10-02T14:03:59.999Z')), {
    article: articleId, publication: publicationId, minute: new Date('2026-10-02T14:03:00.000Z')
  });
});

test('summarize counts collection scans and index use from an explain document, and timed returns the median of three', async () => {
  const explain = {
    queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'status_1_updatedAt_-1__id_-1' } }, rejectedPlans: [{ stage: 'COLLSCAN' }] },
    executionStats: { totalDocsExamined: 21, totalKeysExamined: 22 }
  };
  const plan = summarize(explain);
  assert.deepEqual([...plan.indexes], ['status_1_updatedAt_-1__id_-1']);
  assert.deepEqual([plan.collscans, plan.docs, plan.keys], [0, 21, 22]);
  assert.equal(summarize({ winningPlan: { stage: 'COLLSCAN' } }).collscans, 1);

  let runs = 0;
  assert.equal(typeof await timed(async () => { runs += 1; }), 'number');
  assert.equal(runs, 3);
});
