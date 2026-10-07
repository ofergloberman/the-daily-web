const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { app } = require('../app');
const Article = require('../models/Article');
const PublicationEvent = require('../models/PublicationEvent');
const Session = require('../models/Session');
const ViewStatistic = require('../models/ViewStatistic');
const { hashToken } = require('../middleware/auth');
const { parseRange } = require('../controllers/analyticsController');
const { compareContent, PAGE_SIZE } = require('../controllers/editorController');

const { ObjectId } = mongoose.Types;

const tokens = { editor: 'e'.repeat(64), reporter: 'c'.repeat(64) };

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

test('Editor and analytics routes require an authenticated Editor', async t => {
  const get = await startServer(t);
  const articleId = new ObjectId();
  for (const path of ['/editor', `/editor/articles/${articleId}`, '/analytics', '/analytics/articles', `/analytics/articles/${articleId}/views`]) {
    assert.equal((await get(path)(undefined)).status, 401, `${path} without login`);
    assert.equal((await get(path)(tokens.reporter)).status, 403, `${path} as reporter`);
  }
});

test('Editor desk lists every article, filters by status and rejects invalid input', async t => {
  const get = await startServer(t);
  const calls = {};
  const rows = [
    { _id: new ObjectId(), author: { displayName: 'Dana' }, status: 'pending', updatedAt: new Date('2026-10-02T10:00:00Z'), draft: { title: 'Edited headline' }, published: { title: 'Live headline' } },
    { _id: new ObjectId(), author: { displayName: 'Dana' }, status: 'draft', updatedAt: new Date('2026-10-01T10:00:00Z'), draft: { title: '' }, published: null }
  ];
  const find = t.mock.method(Article, 'find', () => queryDouble(rows, calls));

  const html = await (await get('/editor?status=pending&page=2')(tokens.editor)).text();
  assert.deepEqual(find.mock.calls[0].arguments, [{ status: 'pending' }]);
  assert.equal(calls.skip, PAGE_SIZE);
  assert.equal(calls.limit, PAGE_SIZE + 1);
  assert.deepEqual(calls.sort, { updatedAt: -1, _id: -1 });
  assert.match(html, /Edited headline/);
  assert.match(html, /Update to a published article/);
  assert.match(html, /Untitled article/);
  assert.match(html, /href="\/editor\?status=pending"[^>]*aria-current="page"/);
  assert.match(html, /href="\/editor\?status=pending&amp;page=1">Previous page/);

  await get('/editor')(tokens.editor);
  assert.deepEqual(find.mock.calls[1].arguments, [{}]);

  assert.equal((await get('/editor?status=deleted')(tokens.editor)).status, 400);
  assert.equal((await get('/editor?status=draft&status=pending')(tokens.editor)).status, 400);
  assert.equal((await get('/editor?page=0')(tokens.editor)).status, 400);
  assert.equal(find.mock.callCount(), 2);
});

test('review page shows the published snapshot beside the proposed update', async t => {
  const get = await startServer(t);
  const article = {
    _id: new ObjectId(), author: { displayName: 'Dana' }, status: 'pending', editorNote: '',
    updatedAt: new Date('2026-10-02T10:00:00Z'), lastPublishedAt: new Date('2026-10-01T10:00:00Z'),
    published: { title: 'Old headline', summary: 'Same summary', body: 'Old body', category: 'World', imageUrl: '' },
    draft: { title: 'New headline', summary: 'Same summary', body: 'New <b>body</b>', category: 'World', imageUrl: 'javascript:alert(1)' }
  };
  const findById = t.mock.method(Article, 'findById', () => ({ populate() { return this; }, async lean() { return article; } }));

  const response = await get(`/editor/articles/${article._id}`)(tokens.editor);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(findById.mock.calls[0].arguments, [String(article._id)]);
  assert.match(html, /Currently published/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Old headline/);
  assert.match(html, /New headline/);
  assert.match(html, /New &lt;b&gt;body&lt;\/b&gt;/);
  assert.equal((html.match(/Changed<\/span>/g) || []).length, 3);
  assert.doesNotMatch(html, /<img class="compare-image"/);
  assert.match(html, new RegExp(`href="/analytics\\?article=${article._id}"`));
});

test('review page for a never-published draft shows only the draft and the correction note', async t => {
  const get = await startServer(t);
  const article = {
    _id: new ObjectId(), author: null, status: 'returned', editorNote: 'Add a source.',
    updatedAt: new Date('2026-10-02T10:00:00Z'), lastPublishedAt: null, published: null,
    draft: { title: 'Fresh', summary: '', body: 'Text', category: 'Tech', imageUrl: 'https://example.com/a.jpg' }
  };
  t.mock.method(Article, 'findById', () => ({ populate() { return this; }, async lean() { return article; } }));
  const html = await (await get(`/editor/articles/${article._id}`)(tokens.editor)).text();
  assert.doesNotMatch(html, /Currently published/);
  assert.match(html, /never been published/);
  assert.match(html, /Add a source\./);
  assert.match(html, /<img class="compare-image" src="https:\/\/example.com\/a.jpg"/);
  assert.doesNotMatch(html, /View impact analytics/);
});

test('review page returns 404 for unknown or malformed article ids', async t => {
  const get = await startServer(t);
  const findById = t.mock.method(Article, 'findById', () => ({ populate() { return this; }, async lean() { return null; } }));
  assert.equal((await get(`/editor/articles/${new ObjectId()}`)(tokens.editor)).status, 404);
  assert.equal((await get('/editor/articles/not-an-id')(tokens.editor)).status, 404);
  assert.equal(findById.mock.callCount(), 1);
});

test('compareContent marks only changed fields and treats unpublished articles as all new', () => {
  const draft = { title: 'B', summary: 'S', body: 'Text', category: 'World', imageUrl: '' };
  const updated = compareContent({ published: { ...draft, title: 'A' }, draft });
  assert.deepEqual(updated.filter(field => field.changed).map(field => field.key), ['title']);
  const unpublished = compareContent({ published: null, draft });
  assert.ok(unpublished.every(field => field.current === null && !field.changed));
});

test('analytics article search validates input and returns published titles only', async t => {
  const get = await startServer(t);
  const id = new ObjectId();
  const find = t.mock.method(Article, 'find', () => queryDouble([{ _id: id, published: { title: 'Budget vote' }, publishedAt: new Date('2026-10-01T00:00:00Z'), score: 1.2 }]));

  const found = await (await get('/analytics/articles?q=budget')(tokens.editor)).json();
  assert.deepEqual(find.mock.calls[0].arguments, [{ published: { $ne: null }, $text: { $search: 'budget' } }]);
  assert.deepEqual(found.data, [{ id: String(id), title: 'Budget vote', publishedAt: '2026-10-01T00:00:00.000Z' }]);

  await get('/analytics/articles')(tokens.editor);
  assert.deepEqual(find.mock.calls[1].arguments, [{ published: { $ne: null } }]);

  assert.equal((await get(`/analytics/articles?q=${'x'.repeat(101)}`)(tokens.editor)).status, 400);
  assert.equal((await get('/analytics/articles?q=a&q=b')(tokens.editor)).status, 400);
});

test('view series endpoint returns buckets and markers for a published article', async t => {
  const get = await startServer(t);
  const articleId = new ObjectId();
  const publicationId = new ObjectId();
  t.mock.method(Article, 'findOne', () => ({ select() { return this; }, async lean() { return { _id: articleId, published: { title: 'Budget vote' } }; } }));
  t.mock.method(ViewStatistic, 'aggregate', async () => [{
    series: [{ _id: new Date('2026-10-02T14:01:00Z'), views: 3 }], byPublication: [{ _id: publicationId, views: 3 }]
  }]);
  t.mock.method(PublicationEvent, 'find', () => ({
    sort() { return this; }, select() { return this; },
    async lean() { return [{ _id: publicationId, kind: 'initial', publishedAt: new Date('2026-10-02T14:00:00Z') }]; }
  }));

  const query = 'from=2026-10-02T14:00:00Z&to=2026-10-02T14:03:00Z';
  const response = await get(`/analytics/articles/${articleId}/views?${query}`)(tokens.editor);
  const { data } = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(data.article, { id: String(articleId), title: 'Budget vote' });
  assert.equal(data.unit, 'minute');
  assert.deepEqual(data.points.map(point => point.views), [0, 3, 0]);
  assert.deepEqual(data.publications, [{ id: String(publicationId), kind: 'initial', publishedAt: '2026-10-02T14:00:00.000Z', views: 3 }]);
});

test('view series endpoint rejects bad ids and ranges and reports unknown articles', async t => {
  const get = await startServer(t);
  const articleId = new ObjectId();
  const findOne = t.mock.method(Article, 'findOne', () => ({ select() { return this; }, async lean() { return null; } }));

  assert.equal((await get('/analytics/articles/not-an-id/views')(tokens.editor)).status, 400);
  for (const query of ['from=nonsense', 'to=nonsense', 'from=2026-10-03&to=2026-10-02', 'from=2024-01-01&to=2026-01-01', 'from=a&from=b']) {
    const response = await get(`/analytics/articles/${articleId}/views?${query}`)(tokens.editor);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, 'INVALID_RANGE');
  }
  assert.equal(findOne.mock.callCount(), 0);
  const missing = await get(`/analytics/articles/${articleId}/views`)(tokens.editor);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'ARTICLE_NOT_FOUND');
});

test('parseRange defaults to the last seven days', () => {
  const range = parseRange({});
  assert.equal(range.to.getTime() - range.from.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test('analytics page preselects only a valid article id', async t => {
  const get = await startServer(t);
  const id = new ObjectId();
  assert.match(await (await get(`/analytics?article=${id}`)(tokens.editor)).text(), new RegExp(`data-article-id="${id}"`));
  assert.match(await (await get('/analytics?article=<script>')(tokens.editor)).text(), /data-article-id=""/);
});
