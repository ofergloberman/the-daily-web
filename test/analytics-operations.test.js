const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');
const Article = require('../models/Article');
const analytics = require('../models/analyticsOperations');
const visits = require('../services/visits');

const { ObjectId } = mongoose.Types;

// Article.updateOne reports how many articles matched; a deleted article matches none.
function mockArticleUpdate(t, matchedCount = 1) {
  return t.mock.method(Article, 'updateOne', async () => ({ matchedCount }));
}

test('minuteStart truncates to the UTC minute', () => {
  assert.equal(analytics.minuteStart(new Date('2026-10-02T14:03:59.999Z')).toISOString(), '2026-10-02T14:03:00.000Z');
  assert.equal(analytics.minuteStart(new Date('2026-10-02T14:03:00.000Z')).toISOString(), '2026-10-02T14:03:00.000Z');
});

test('chooseUnit keeps every graph to a bounded number of points', () => {
  const hour = 60 * 60 * 1000;
  assert.equal(analytics.chooseUnit(6 * hour), 'minute');
  assert.equal(analytics.chooseUnit(6 * hour + 1), 'hour');
  assert.equal(analytics.chooseUnit(31 * 24 * hour), 'hour');
  assert.equal(analytics.chooseUnit(31 * 24 * hour + 1), 'day');
});

test('fillSeries adds zero-view buckets for quiet periods', () => {
  const from = new Date('2026-10-02T14:00:30Z');
  const to = new Date('2026-10-02T14:03:00Z');
  const viewsByTime = new Map([[Date.parse('2026-10-02T14:01:00Z'), 4]]);
  assert.deepEqual(analytics.fillSeries(viewsByTime, from, to, 'minute'), [
    { time: '2026-10-02T14:00:00.000Z', views: 0 },
    { time: '2026-10-02T14:01:00.000Z', views: 4 },
    { time: '2026-10-02T14:02:00.000Z', views: 0 }
  ]);
});

test('recordVisit increments the minute bucket with an atomic upsert', async t => {
  mockArticleUpdate(t);
  const updateOne = t.mock.method(ViewStatistic, 'updateOne', async () => ({}));
  const article = new ObjectId();
  const publication = new ObjectId();
  await analytics.recordVisit(article, publication, new Date('2026-10-02T14:03:42.500Z'));
  assert.equal(updateOne.mock.callCount(), 1);
  assert.deepEqual(updateOne.mock.calls[0].arguments, [
    { article, publication, minute: new Date('2026-10-02T14:03:00Z') },
    { $inc: { count: 1 } },
    { upsert: true }
  ]);
});

test('recordVisit also increments totalViews without touching updatedAt', async t => {
  const articleUpdate = mockArticleUpdate(t);
  t.mock.method(ViewStatistic, 'updateOne', async () => ({}));
  const article = new ObjectId();
  await analytics.recordVisit(article, new ObjectId());
  assert.deepEqual(articleUpdate.mock.calls[0].arguments, [{ _id: article }, { $inc: { totalViews: 1 } }, { timestamps: false }]);
});

test('recordVisit counts popularity but no bucket when no publication was served', async t => {
  const articleUpdate = mockArticleUpdate(t);
  const bucket = t.mock.method(ViewStatistic, 'updateOne', async () => ({}));
  await analytics.recordVisit(new ObjectId(), null);
  assert.equal(articleUpdate.mock.callCount(), 1);
  assert.equal(bucket.mock.callCount(), 0);
});

test('recordVisit leaves no statistics behind for an article that no longer exists', async t => {
  mockArticleUpdate(t, 0);
  const bucket = t.mock.method(ViewStatistic, 'updateOne', async () => ({}));
  await analytics.recordVisit(new ObjectId(), new ObjectId());
  assert.equal(bucket.mock.callCount(), 0);
});

test('recordVisit retries once when a concurrent visit created the bucket first', async t => {
  mockArticleUpdate(t);
  let attempts = 0;
  t.mock.method(ViewStatistic, 'updateOne', async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    return {};
  });
  await analytics.recordVisit(new ObjectId(), new ObjectId());
  assert.equal(attempts, 2);
});

test('recordVisit does not hide repeated or unrelated database errors', async t => {
  mockArticleUpdate(t);
  const updateOne = t.mock.method(ViewStatistic, 'updateOne', async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); });
  await assert.rejects(analytics.recordVisit(new ObjectId(), new ObjectId()), { code: 11000 });
  assert.equal(updateOne.mock.callCount(), 2);
  updateOne.mock.restore();
  const failing = t.mock.method(ViewStatistic, 'updateOne', async () => { throw new Error('network'); });
  await assert.rejects(analytics.recordVisit(new ObjectId(), new ObjectId()), { message: 'network' });
  assert.equal(failing.mock.callCount(), 1);
});

test('recordVisit stops before the bucket when the popularity counter fails', async t => {
  t.mock.method(Article, 'updateOne', async () => { throw new Error('article write failed'); });
  const bucket = t.mock.method(ViewStatistic, 'updateOne', async () => ({}));
  await assert.rejects(analytics.recordVisit(new ObjectId(), new ObjectId()), { message: 'article write failed' });
  assert.equal(bucket.mock.callCount(), 0);
});

test('getViewSeries combines buckets, zero gaps and per-publication totals', async t => {
  const article = new ObjectId();
  const first = new ObjectId();
  const second = new ObjectId();
  const aggregate = t.mock.method(ViewStatistic, 'aggregate', async () => [{
    series: [{ _id: new Date('2026-10-02T14:01:00Z'), views: 4 }, { _id: new Date('2026-10-02T14:03:00Z'), views: 6 }],
    byPublication: [{ _id: first, views: 4 }, { _id: second, views: 6 }],
    bucketPublications: [
      { _id: { bucket: new Date('2026-10-02T14:01:00Z'), publication: first }, views: 4 },
      { _id: { bucket: new Date('2026-10-02T14:03:00Z'), publication: first }, views: 1 },
      { _id: { bucket: new Date('2026-10-02T14:03:00Z'), publication: second }, views: 5 }
    ]
  }]);
  t.mock.method(PublicationEvent, 'find', () => ({
    sort() { return this; }, select() { return this; },
    async lean() {
      return [
        { _id: first, kind: 'initial', publishedAt: new Date('2026-10-02T14:00:10Z') },
        { _id: second, kind: 'update', publishedAt: new Date('2026-10-02T14:03:30Z') }
      ];
    }
  }));

  const from = new Date('2026-10-02T14:00:00Z');
  const to = new Date('2026-10-02T14:05:00Z');
  const series = await analytics.getViewSeries(String(article), from, to);

  const [pipeline] = aggregate.mock.calls[0].arguments;
  assert.deepEqual(pipeline[0].$match, { article, minute: { $gte: from, $lt: to } });
  assert.equal(pipeline[1].$facet.series[0].$group._id.$dateTrunc.unit, 'minute');
  assert.equal(pipeline[1].$facet.bucketPublications[0].$group._id.bucket.$dateTrunc.unit, 'minute');
  assert.equal(pipeline[1].$facet.bucketPublications[0].$group._id.publication, '$publication');
  assert.equal(series.unit, 'minute');
  assert.deepEqual(series.points.map(point => point.views), [0, 4, 0, 6, 0]);
  assert.deepEqual(series.splits, [
    { time: '2026-10-02T14:03:00.000Z', byPublication: { [first]: 1, [second]: 5 } }
  ]);
  assert.deepEqual(series.publications, [
    { id: String(first), kind: 'initial', publishedAt: '2026-10-02T14:00:10.000Z', views: 4 },
    { id: String(second), kind: 'update', publishedAt: '2026-10-02T14:03:30.000Z', views: 6 }
  ]);
});

test('getViewSeries lists publications without views in the range as zero', async t => {
  const event = { _id: new ObjectId(), kind: 'initial', publishedAt: new Date('2026-09-01T00:00:00Z') };
  t.mock.method(ViewStatistic, 'aggregate', async () => [{ series: [], byPublication: [], bucketPublications: [] }]);
  t.mock.method(PublicationEvent, 'find', () => ({ sort() { return this; }, select() { return this; }, async lean() { return [event]; } }));
  const series = await analytics.getViewSeries(new ObjectId(), new Date('2026-10-02T00:00:00Z'), new Date('2026-10-03T00:00:00Z'));
  assert.equal(series.unit, 'hour');
  assert.equal(series.points.length, 24);
  assert.equal(series.publications[0].views, 0);
  assert.deepEqual(series.splits, []);
});

// Mocks the aggregate rows ([bucket ISO, publication id, views]) and events ([id, ISO time]) for a one-minute-bucket range.
async function splitsFor(t, rows, events) {
  t.mock.method(ViewStatistic, 'aggregate', async () => [{
    series: [], byPublication: [],
    bucketPublications: rows.map(([bucket, publication, views]) => ({ _id: { bucket: new Date(bucket), publication }, views }))
  }]);
  t.mock.method(PublicationEvent, 'find', () => ({
    sort() { return this; }, select() { return this; },
    async lean() { return events.map(([_id, publishedAt]) => ({ _id, kind: 'update', publishedAt: new Date(publishedAt) })); }
  }));
  const series = await analytics.getViewSeries(new ObjectId(), new Date('2026-10-02T14:00:00Z'), new Date('2026-10-02T14:05:00Z'));
  return series.splits;
}

test('getViewSeries splits a bucket whose publication marker lies strictly inside it', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:02:00Z', first, 2], ['2026-10-02T14:02:00Z', second, 3]],
    [[first, '2026-10-02T14:00:10Z'], [second, '2026-10-02T14:02:30Z']]);
  assert.deepEqual(splits, [{ time: '2026-10-02T14:02:00.000Z', byPublication: { [first]: 2, [second]: 3 } }]);
});

test('getViewSeries gives no split to a bucket without a marker inside', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:01:00Z', first, 2], ['2026-10-02T14:03:00Z', second, 3]],
    [[first, '2026-10-02T14:00:10Z'], [second, '2026-10-02T14:02:30Z']]);
  assert.deepEqual(splits, []);
});

test('getViewSeries gives no split to a marker inside a bucket without views (the client draws it as zero)', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:01:00Z', first, 2], ['2026-10-02T14:03:00Z', second, 3]],
    [[first, '2026-10-02T14:00:10Z'], [second, '2026-10-02T14:02:30Z']]);
  assert.ok(!splits.some(split => split.time === '2026-10-02T14:02:00.000Z'));
});

test('getViewSeries gives no split to a marker exactly on a bucket start', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:01:00Z', first, 2], ['2026-10-02T14:02:00Z', second, 3]],
    [[first, '2026-10-02T14:00:00Z'], [second, '2026-10-02T14:02:00Z']]);
  assert.deepEqual(splits, []);
});

test('getViewSeries keeps all three versions in one split when two markers lie inside a bucket', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const third = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:02:00Z', first, 1], ['2026-10-02T14:02:00Z', second, 2], ['2026-10-02T14:02:00Z', third, 3]],
    [[first, '2026-10-02T14:00:00Z'], [second, '2026-10-02T14:02:20Z'], [third, '2026-10-02T14:02:40Z']]);
  assert.deepEqual(splits, [{ time: '2026-10-02T14:02:00.000Z', byPublication: { [first]: 1, [second]: 2, [third]: 3 } }]);
});

test('getViewSeries sorts splits by time', async t => {
  const first = new ObjectId();
  const second = new ObjectId();
  const splits = await splitsFor(t,
    [['2026-10-02T14:03:00Z', second, 1], ['2026-10-02T14:01:00Z', first, 1]],
    [[first, '2026-10-02T14:01:30Z'], [second, '2026-10-02T14:03:30Z']]);
  assert.deepEqual(splits.map(split => split.time), ['2026-10-02T14:01:00.000Z', '2026-10-02T14:03:00.000Z']);
});

test('the visit service attributes a view to the publication the reader was served', async t => {
  const article = { _id: new ObjectId(), currentPublication: new ObjectId() };
  const record = t.mock.method(analytics, 'recordVisit', async () => {});
  await visits.recordVisit(article);
  assert.deepEqual(record.mock.calls[0].arguments, [article._id, article.currentPublication]);
});

test('the visit service still counts articles that have no current publication', async t => {
  const article = { _id: new ObjectId() };
  const record = t.mock.method(analytics, 'recordVisit', async () => {});
  await visits.recordVisit(article);
  assert.deepEqual(record.mock.calls[0].arguments, [article._id, null]);
});
