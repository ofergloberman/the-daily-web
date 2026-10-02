const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const PublicationEvent = require('../models/PublicationEvent');
const ViewStatistic = require('../models/ViewStatistic');

test('publication history supports multiple updates and separate counts within a minute', async () => {
  const article = new mongoose.Types.ObjectId();
  const editor = new mongoose.Types.ObjectId();
  const events = [
    new PublicationEvent({ article, editor, kind: 'initial', publishedAt: '2026-10-02T13:00:00Z' }),
    new PublicationEvent({ article, editor, kind: 'update', publishedAt: '2026-10-02T14:00:10Z' }),
    new PublicationEvent({ article, editor, kind: 'update', publishedAt: '2026-10-02T14:00:40Z' })
  ];
  for (const event of events) await event.validate();
  const buckets = events.map((event, index) => new ViewStatistic({
    article, publication: event._id, minute: '2026-10-02T14:00:00Z', count: index + 1
  }));
  for (const bucket of buckets) await bucket.validate();
  assert.equal(new Set(buckets.map(bucket => String(bucket.publication))).size, 3);
  assert.equal(buckets.reduce((total, bucket) => total + bucket.count, 0), 6);
  assert.equal(events[0].publishedAt.toISOString(), '2026-10-02T13:00:00.000Z');
});

test('analytics schemas reject incomplete events and invalid buckets', async () => {
  const article = new mongoose.Types.ObjectId();
  const editor = new mongoose.Types.ObjectId();
  const publication = new mongoose.Types.ObjectId();
  const event = { article, editor, kind: 'update', publishedAt: new Date() };
  for (const field of ['article', 'editor', 'kind', 'publishedAt']) {
    await assert.rejects(new PublicationEvent({ ...event, [field]: undefined }).validate(),
      error => Boolean(error.errors[field]));
  }
  await assert.rejects(new PublicationEvent({ ...event, kind: 'draft' }).validate(),
    error => Boolean(error.errors.kind));
  await assert.rejects(new PublicationEvent({ ...event, publishedAt: 'invalid' }).validate(),
    error => Boolean(error.errors.publishedAt));

  const bucket = { article, publication, minute: new Date('2026-10-02T14:00:00Z') };
  assert.equal(new ViewStatistic(bucket).count, 0);
  for (const field of ['article', 'publication', 'minute']) {
    await assert.rejects(new ViewStatistic({ ...bucket, [field]: undefined }).validate(),
      error => Boolean(error.errors[field]));
  }
  for (const count of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    await assert.rejects(new ViewStatistic({ ...bucket, count }).validate(),
      error => Boolean(error.errors.count));
  }
  for (const minute of ['invalid', '2026-10-02T14:00:01Z', '2026-10-02T14:00:00.001Z']) {
    await assert.rejects(new ViewStatistic({ ...bucket, minute }).validate(),
      error => Boolean(error.errors.minute));
  }
});
