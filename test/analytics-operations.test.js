const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');
const analytics = require('../models/analyticsOperations');
const visits = require('../services/visits');

const { ObjectId } = mongoose.Types;

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

test('recordVisit retries once when a concurrent visit created the bucket first', async t => {
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
  const updateOne = t.mock.method(ViewStatistic, 'updateOne', async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); });
  await assert.rejects(analytics.recordVisit(new ObjectId(), new ObjectId()), { code: 11000 });
  assert.equal(updateOne.mock.callCount(), 2);
  updateOne.mock.restore();
  const failing = t.mock.method(ViewStatistic, 'updateOne', async () => { throw new Error('network'); });
  await assert.rejects(analytics.recordVisit(new ObjectId(), new ObjectId()), { message: 'network' });
  assert.equal(failing.mock.callCount(), 1);
});

test('findLatestPublicationId returns the newest event or null', async t => {
  const id = new ObjectId();
  let found = { _id: id };
  const query = { sort(order) { this.order = order; return this; }, select() { return this; }, async lean() { return found; } };
  const findOne = t.mock.method(PublicationEvent, 'findOne', () => query);
  const article = new ObjectId();
  assert.equal(await analytics.findLatestPublicationId(article), id);
  assert.deepEqual(findOne.mock.calls[0].arguments, [{ article }]);
  assert.deepEqual(query.order, { publishedAt: -1 });
  found = null;
  assert.equal(await analytics.findLatestPublicationId(article), null);
});

test('createPublicationEvent stores one server-timed event inside the given session', async t => {
  const session = { id: 'transaction' };
  const create = t.mock.method(PublicationEvent, 'create', async docs => docs);
  const article = new ObjectId();
  const editor = new ObjectId();
  const event = await analytics.createPublicationEvent({ article, editor, kind: 'update' }, session);
  const [docs, options] = create.mock.calls[0].arguments;
  assert.equal(docs.length, 1);
  assert.deepEqual({ ...docs[0], publishedAt: undefined }, { article, editor, kind: 'update', publishedAt: undefined });
  assert.ok(docs[0].publishedAt instanceof Date);
  assert.deepEqual(options, { session });
  assert.equal(event, docs[0]);
});

test('deleteArticleAnalytics removes statistics and events for one article', async t => {
  const session = { id: 'transaction' };
  const article = new ObjectId();
  const statistics = t.mock.method(ViewStatistic, 'deleteMany', async () => ({}));
  const events = t.mock.method(PublicationEvent, 'deleteMany', async () => ({}));
  await analytics.deleteArticleAnalytics(article, session);
  assert.deepEqual(statistics.mock.calls[0].arguments, [{ article }, { session }]);
  assert.deepEqual(events.mock.calls[0].arguments, [{ article }, { session }]);
});

test('getViewSeries combines buckets, zero gaps and per-publication totals', async t => {
  const article = new ObjectId();
  const first = new ObjectId();
  const second = new ObjectId();
  const aggregate = t.mock.method(ViewStatistic, 'aggregate', async () => [{
    series: [{ _id: new Date('2026-10-02T14:01:00Z'), views: 4 }, { _id: new Date('2026-10-02T14:03:00Z'), views: 6 }],
    byPublication: [{ _id: first, views: 4 }, { _id: second, views: 6 }]
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
  assert.equal(series.unit, 'minute');
  assert.deepEqual(series.points.map(point => point.views), [0, 4, 0, 6, 0]);
  assert.deepEqual(series.publications, [
    { id: String(first), kind: 'initial', publishedAt: '2026-10-02T14:00:10.000Z', views: 4 },
    { id: String(second), kind: 'update', publishedAt: '2026-10-02T14:03:30.000Z', views: 6 }
  ]);
});

test('getViewSeries lists publications without views in the range as zero', async t => {
  const event = { _id: new ObjectId(), kind: 'initial', publishedAt: new Date('2026-09-01T00:00:00Z') };
  t.mock.method(ViewStatistic, 'aggregate', async () => [{ series: [], byPublication: [] }]);
  t.mock.method(PublicationEvent, 'find', () => ({ sort() { return this; }, select() { return this; }, async lean() { return [event]; } }));
  const series = await analytics.getViewSeries(new ObjectId(), new Date('2026-10-02T00:00:00Z'), new Date('2026-10-03T00:00:00Z'));
  assert.equal(series.unit, 'hour');
  assert.equal(series.points.length, 24);
  assert.equal(series.publications[0].views, 0);
});

test('the visit service attributes a view to the latest publication', async t => {
  const article = { _id: new ObjectId() };
  const publication = new ObjectId();
  t.mock.method(analytics, 'findLatestPublicationId', async () => publication);
  const record = t.mock.method(analytics, 'recordVisit', async () => {});
  await visits.recordVisit(article);
  assert.deepEqual(record.mock.calls[0].arguments, [article._id, publication]);
});

test('the visit service skips articles that have no publication event', async t => {
  t.mock.method(analytics, 'findLatestPublicationId', async () => null);
  const record = t.mock.method(analytics, 'recordVisit', async () => {});
  await visits.recordVisit({ _id: new ObjectId() });
  assert.equal(record.mock.callCount(), 0);
});
