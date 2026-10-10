const mongoose = require('mongoose');
const PublicationEvent = require('./PublicationEvent');
const ViewStatistic = require('./ViewStatistic');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const UNIT_MS = Object.freeze({ minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS });
const MAX_RANGE_MS = 366 * DAY_MS;
const DUPLICATE_KEY_ERROR = 11000;

function minuteStart(time) {
  return new Date(Math.floor(time.getTime() / MINUTE_MS) * MINUTE_MS);
}

// Coarser units keep every graph at or below roughly 750 points.
function chooseUnit(rangeMs) {
  if (rangeMs <= 6 * HOUR_MS) return 'minute';
  if (rangeMs <= 31 * DAY_MS) return 'hour';
  return 'day';
}

function unitStart(timeMs, unit) {
  return Math.floor(timeMs / UNIT_MS[unit]) * UNIT_MS[unit];
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}

function incrementBucket(filter) {
  return ViewStatistic.updateOne(filter, { $inc: { count: 1 } }, { upsert: true });
}

// Atomic $inc with upsert; a concurrent first visit can make the upsert fail once on the unique index.
async function recordVisit(articleId, publicationId, visitTime = new Date()) {
  const filter = { article: articleId, publication: publicationId, minute: minuteStart(visitTime) };
  try {
    await incrementBucket(filter);
  } catch (error) {
    if (error.code !== DUPLICATE_KEY_ERROR) throw error;
    await incrementBucket(filter);
  }
}

async function findLatestPublicationId(articleId) {
  const event = await PublicationEvent.findOne({ article: articleId }).sort({ publishedAt: -1 }).select('_id').lean();
  return event?._id ?? null;
}

// Pass the surrounding transaction session so the event commits together with the new public snapshot.
async function createPublicationEvent({ article, editor, kind, publishedAt = new Date() }, session) {
  const [event] = await PublicationEvent.create([{ article, editor, kind, publishedAt }], { session });
  return event;
}

async function deleteArticleAnalytics(articleId, session) {
  await ViewStatistic.deleteMany({ article: articleId }, { session });
  await PublicationEvent.deleteMany({ article: articleId }, { session });
}

// Fills buckets without visits so quiet periods appear as zero instead of being skipped.
function fillSeries(viewsByTime, from, to, unit) {
  const points = [];
  for (let time = unitStart(from.getTime(), unit); time < to.getTime(); time += UNIT_MS[unit]) {
    points.push({ time: new Date(time).toISOString(), views: viewsByTime.get(time) ?? 0 });
  }
  return points;
}

async function aggregateViews(articleId, from, to, unit) {
  const [result] = await ViewStatistic.aggregate([
    { $match: { article: articleId, minute: { $gte: from, $lt: to } } },
    {
      $facet: {
        series: [{ $group: { _id: { $dateTrunc: { date: '$minute', unit } }, views: { $sum: '$count' } } }],
        byPublication: [{ $group: { _id: '$publication', views: { $sum: '$count' } } }]
      }
    }
  ]);
  return result;
}

// Views per time bucket plus every publication of the article with the views its version received in the range.
async function getViewSeries(articleId, from, to) {
  const id = toObjectId(articleId);
  const unit = chooseUnit(to.getTime() - from.getTime());
  const [counts, events] = await Promise.all([
    aggregateViews(id, from, to, unit),
    PublicationEvent.find({ article: id }).sort({ publishedAt: 1 }).select('kind publishedAt').lean()
  ]);
  const viewsByTime = new Map(counts.series.map(bucket => [bucket._id.getTime(), bucket.views]));
  const viewsByPublication = new Map(counts.byPublication.map(row => [String(row._id), row.views]));
  return {
    unit,
    from: from.toISOString(),
    to: to.toISOString(),
    points: fillSeries(viewsByTime, from, to, unit),
    publications: events.map(event => ({
      id: String(event._id),
      kind: event.kind,
      publishedAt: event.publishedAt.toISOString(),
      views: viewsByPublication.get(String(event._id)) ?? 0
    }))
  };
}

module.exports = {
  MAX_RANGE_MS,
  minuteStart,
  chooseUnit,
  fillSeries,
  recordVisit,
  findLatestPublicationId,
  createPublicationEvent,
  deleteArticleAnalytics,
  getViewSeries
};
