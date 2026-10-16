const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');
const { EDITOR_SEARCH_MAX_LENGTH } = require('../config/constants');
const { escapeRegExp } = require('../helpers/escapeRegExp');
const { editorDeskFilter, listForEditor } = require('../models/editorArticleQueries');
const { deskUrl, parseDeskQuery, toDeskRow } = require('../controllers/editorController');
const { EDITOR_DESK_PAGE_SIZE: PAGE_SIZE } = require('../config/constants');
const { stubConnected } = require('./connectionState');

const { ObjectId } = mongoose.Types;

const tokens = { editor: 'e'.repeat(64), reporter: 'c'.repeat(64) };
const REGEX_SPECIAL_CHARACTERS = '.*+?^${}()|[]\\';

async function startServer(t) {
  const users = new Map([
    [hashToken(tokens.editor), { _id: new ObjectId(), displayName: 'Eli Editor', role: 'editor' }],
    [hashToken(tokens.reporter), { _id: new ObjectId(), displayName: 'Rina Reporter', role: 'reporter' }]
  ]);
  t.mock.method(Session, 'findOne', ({ tokenHash }) => ({ populate: async () => {
    const user = users.get(tokenHash);
    return user ? { user } : null;
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return path => token => fetch(base + path, token ? { headers: { Cookie: `wd_session=${token}` } } : {});
}

function queryDouble(rows, calls = {}) {
  return {
    select(fields) { calls.select = fields; return this; },
    sort(order) { calls.sort = order; return this; },
    skip(count) { calls.skip = count; return this; },
    limit(count) { calls.limit = count; return this; },
    populate() { return this; },
    async lean() { return rows; }
  };
}

function article(overrides = {}) {
  return {
    _id: new ObjectId(), author: { displayName: 'Dana' }, status: 'pending', updatedAt: new Date('2026-10-02T10:00:00Z'),
    draft: { title: 'Edited headline' }, published: { title: 'Live headline' }, ...overrides
  };
}

test('escapeRegExp turns every special character into a literal one', () => {
  assert.equal(escapeRegExp('a.b*('), 'a\\.b\\*\\(');
  assert.equal(escapeRegExp('plain words'), 'plain words');
  assert.ok(new RegExp(`^${escapeRegExp(REGEX_SPECIAL_CHARACTERS)}$`).test(REGEX_SPECIAL_CHARACTERS));
});

test('editorDeskFilter is empty or status-only without a search', () => {
  assert.deepEqual(editorDeskFilter({ status: '', q: '' }), {});
  assert.deepEqual(editorDeskFilter({ q: '' }), {});
  assert.deepEqual(editorDeskFilter({ status: 'draft', q: '' }), { status: 'draft' });
});

test('editorDeskFilter matches either title case-insensitively and combines with a status', () => {
  const pattern = { $regex: 'united', $options: 'i' };
  assert.deepEqual(editorDeskFilter({ status: '', q: 'united' }), { $or: [{ 'draft.title': pattern }, { 'published.title': pattern }] });
  assert.deepEqual(editorDeskFilter({ status: 'pending', q: 'united' }), {
    status: 'pending', $or: [{ 'draft.title': pattern }, { 'published.title': pattern }]
  });
});

test('editorDeskFilter escapes metacharacters so the term is matched literally', () => {
  const [{ 'draft.title': pattern }] = editorDeskFilter({ q: 'a.b*(' }).$or;
  const regex = new RegExp(pattern.$regex, pattern.$options);
  assert.ok(regex.test('Lineup: A.B*( preview'));
  assert.equal(regex.test('aXbbb'), false, '. and * are not wildcards');
  assert.doesNotThrow(() => new RegExp(editorDeskFilter({ q: '(' }).$or[0]['draft.title'].$regex));
});

test('listForEditor passes the filter to Article.find and keeps the desk order and paging', async t => {
  const calls = {};
  const find = t.mock.method(Article, 'find', () => queryDouble([article(), article()], calls));
  const result = await listForEditor({ status: 'draft', q: 'united', page: 2, pageSize: 1 });
  assert.deepEqual(find.mock.calls[0].arguments, [editorDeskFilter({ status: 'draft', q: 'united' })]);
  assert.equal(calls.skip, 1);
  assert.equal(calls.limit, 2);
  assert.deepEqual(calls.sort, { updatedAt: -1, _id: -1 });
  assert.equal(result.articles.length, 1);
  assert.equal(result.hasNext, true);
});

test('parseDeskQuery returns trimmed values with defaults', () => {
  assert.deepEqual(parseDeskQuery({}), { value: { page: 1, status: '', q: '' } });
  assert.deepEqual(parseDeskQuery({ q: '  united  ', status: 'pending', page: '3' }), { value: { page: 3, status: 'pending', q: 'united' } });
  assert.deepEqual(parseDeskQuery({ q: '   ' }).value.q, '', 'whitespace only means no search');
  assert.equal(parseDeskQuery({ q: 'x'.repeat(EDITOR_SEARCH_MAX_LENGTH) }).error, undefined);
});

test('parseDeskQuery rejects bad search, status and page with a 400 and a code', () => {
  const failure = query => parseDeskQuery(query).error;
  assert.deepEqual(failure({ q: 'x'.repeat(EDITOR_SEARCH_MAX_LENGTH + 1) }), {
    status: 400, error: 'INVALID_SEARCH', message: `Search must be at most ${EDITOR_SEARCH_MAX_LENGTH} characters.`
  });
  assert.equal(failure({ q: ['a', 'b'] }).error, 'INVALID_SEARCH');
  assert.equal(failure({ status: 'deleted' }).error, 'INVALID_STATUS');
  assert.equal(failure({ status: ['draft', 'pending'] }).error, 'INVALID_STATUS');
  assert.equal(failure({ page: '0' }).error, 'INVALID_PAGE');
  assert.equal(failure({ page: 'abc' }).status, 400);
});

test('deskUrl keeps search, status and page and leaves empty values out', () => {
  assert.equal(deskUrl({ q: '', status: '' }), '/editor');
  assert.equal(deskUrl({ status: 'draft' }), '/editor?status=draft');
  assert.equal(deskUrl({ q: 'Man Utd & co', status: 'pending', page: 2 }), '/editor?q=Man+Utd+%26+co&status=pending&page=2');
});

test('toDeskRow has the shared row shape with fallbacks', () => {
  const id = new ObjectId();
  assert.deepEqual(toDeskRow(article({ _id: id })), {
    id: String(id), title: 'Edited headline', authorName: 'Dana', updatedAt: '2026-10-02T10:00:00.000Z', updatedLabel: 'Oct 2, 2026',
    status: 'pending', statusLabel: 'Pending approval', isPublishedUpdate: true
  });
  const bare = toDeskRow(article({ author: null, draft: { title: '' }, published: null, status: 'draft' }));
  assert.equal(bare.title, 'Untitled article');
  assert.equal(bare.authorName, 'Unknown reporter');
  assert.equal(bare.isPublishedUpdate, false);
  assert.equal(toDeskRow(article({ draft: { title: '' } })).title, 'Live headline');
  assert.equal(toDeskRow(article({ status: 'published' })).isPublishedUpdate, false);
});

test('GET /editor/articles returns the rows, page and hasNext for an Editor', async t => {
  const get = await startServer(t);
  const rows = Array.from({ length: PAGE_SIZE + 1 }, () => article());
  const find = t.mock.method(Article, 'find', () => queryDouble(rows));
  const response = await get('/editor/articles?q=%20headline%20&status=pending&page=2')(tokens.editor);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(find.mock.calls[0].arguments, [editorDeskFilter({ status: 'pending', q: 'headline' })]);
  assert.equal(body.data.page, 2);
  assert.equal(body.data.hasNext, true);
  assert.equal(body.data.articles.length, PAGE_SIZE);
  assert.deepEqual(Object.keys(body.data.articles[0]).sort(), ['authorName', 'id', 'isPublishedUpdate', 'status', 'statusLabel', 'title', 'updatedAt', 'updatedLabel']);
  assert.equal(body.data.articles[0].title, 'Edited headline');
});

test('GET /editor/articles rejects guests with 401 and Reporters with 403 before any query', async t => {
  const get = await startServer(t);
  const find = t.mock.method(Article, 'find', () => queryDouble([]));
  assert.equal((await get('/editor/articles?q=a')(undefined)).status, 401);
  assert.equal((await get('/editor/articles?q=a')(tokens.reporter)).status, 403);
  assert.equal(find.mock.callCount(), 0);
});

test('GET /editor/articles answers bad input with a 400 JSON error and never queries', async t => {
  const get = await startServer(t);
  const find = t.mock.method(Article, 'find', () => queryDouble([]));
  const cases = [
    ['?q=a&q=b', 'INVALID_SEARCH'],
    [`?q=${'x'.repeat(EDITOR_SEARCH_MAX_LENGTH + 1)}`, 'INVALID_SEARCH'],
    ['?status=deleted', 'INVALID_STATUS'],
    ['?page=0', 'INVALID_PAGE']
  ];
  for (const [query, code] of cases) {
    const response = await get(`/editor/articles${query}`)(tokens.editor);
    const body = await response.json();
    assert.equal(response.status, 400, query);
    assert.equal(body.error, code);
    assert.equal(typeof body.message, 'string');
  }
  assert.equal(find.mock.callCount(), 0);
});

test('a database failure on the JSON route is a 500 error body and the server keeps answering', async t => {
  const get = await startServer(t);
  stubConnected(t);
  t.mock.method(console, 'error', () => {});
  const find = t.mock.method(Article, 'find', () => { throw new Error('database down'); });
  const failed = await get('/editor/articles?q=a')(tokens.editor);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Try again.' });
  find.mock.mockImplementation(() => queryDouble([]));
  assert.equal((await get('/editor/articles')(tokens.editor)).status, 200);
});

test('GET /editor shows the search box with the escaped value and a bounded length', async t => {
  const get = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([article()]));
  const html = await (await get(`/editor?q=${encodeURIComponent('"><script>alert(1)</script>')}`)(tokens.editor)).text();
  assert.match(html, /<form class="feed-controls" id="desk-search" method="get" action="\/editor" role="search">/);
  assert.match(html, new RegExp(`<input class="field" id="desk-q" name="q" type="search" maxlength="${EDITOR_SEARCH_MAX_LENGTH}" value="&#34;&gt;&lt;script&gt;alert\\(1\\)&lt;/script&gt;"`));
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.match(html, /<label class="field-label" for="desk-q">Search titles<\/label>/);
  assert.match(html, /<p class="feed-status" id="desk-status" role="status" aria-live="polite"><\/p>/);
  assert.match(html, /<script src="\/editor-desk\.js" defer><\/script>/);
  assert.doesNotMatch(html, /name="status"/, 'no hidden status input without a status');
});

test('GET /editor chip and pager links keep the search and the status', async t => {
  const get = await startServer(t);
  const find = t.mock.method(Article, 'find', () => queryDouble(Array.from({ length: PAGE_SIZE + 1 }, () => article())));
  const html = await (await get('/editor?q=Man%20Utd&status=pending&page=2')(tokens.editor)).text();
  assert.deepEqual(find.mock.calls[0].arguments, [editorDeskFilter({ status: 'pending', q: 'Man Utd' })]);
  assert.match(html, /<input type="hidden" name="status" value="pending">/);
  assert.match(html, /value="Man Utd"/);
  assert.match(html, /href="\/editor\?q=Man\+Utd">All</);
  assert.match(html, /href="\/editor\?q=Man\+Utd&amp;status=draft">Draft</);
  assert.match(html, /href="\/editor\?q=Man\+Utd&amp;status=pending"[^>]*aria-current="page">Pending approval</);
  assert.match(html, /href="\/editor\?q=Man\+Utd&amp;status=pending&amp;page=1">Previous page</);
  assert.match(html, /href="\/editor\?q=Man\+Utd&amp;status=pending&amp;page=3">Next page</);
  assert.match(html, /<a class="desk-link desk-clear" id="desk-clear" data-clear href="\/editor\?status=pending">Clear search<\/a>/);
});

test('GET /editor with no results for a search offers Clear search and escapes the term', async t => {
  const get = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([]));
  const html = await (await get('/editor?q=%3Ci%3Ezzz&status=draft')(tokens.editor)).text();
  assert.match(html, /No articles match “&lt;i&gt;zzz”/);
  assert.doesNotMatch(html, /<i>zzz/);
  assert.match(html, /<a class="desk-link" data-clear href="\/editor\?status=draft">Clear search<\/a>/);
  assert.match(html, /id="desk-pager"[^>]*hidden/);
});

test('GET /editor without a search keeps the original empty-state messages and hides the clear link', async t => {
  const get = await startServer(t);
  t.mock.method(Article, 'find', () => queryDouble([]));
  const first = await (await get('/editor?status=returned')(tokens.editor)).text();
  assert.match(first, /There are no articles with this status yet\./);
  assert.match(first, /id="desk-clear" data-clear href="\/editor\?status=returned" hidden>/);
  const later = await (await get('/editor?page=3')(tokens.editor)).text();
  assert.match(later, /There are no more articles\./);
  assert.match(later, /href="\/editor\?page=2">Previous page</);
});
