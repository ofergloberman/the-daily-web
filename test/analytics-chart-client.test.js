// Runs public/analytics.js in a VM with a recording canvas to check where the views line is drawn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/analytics.js'), 'utf8');

// Same numbers as MARGIN in public/analytics.js.
const MARGIN_LEFT = 64;
const MARGIN_RIGHT = 20;
const MARGIN_TOP = 28;
const MARGIN_BOTTOM = 36;
const CANVAS_WIDTH = 784;
const CANVAS_HEIGHT = 400;
const PLOT_WIDTH = CANVAS_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const PLOT_HEIGHT = CANVAS_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
const BASELINE_Y = MARGIN_TOP + PLOT_HEIGHT;
// The test data peaks at 6 views, so the script picks a y step of 2 and a y axis from 0 to 8 (4 ticks).
const Y_AXIS_MAX = 8;
const HOUR_MS = 60 * 60 * 1000;
const ARTICLE_ID = '64b7f0f2a1b2c3d4e5f60718';

const FROM = Date.parse('2026-10-15T18:00:00.000Z');
const TO = Date.parse('2026-10-16T00:00:00.000Z');
const PUBLISHED = Date.parse('2026-10-15T20:40:00.000Z');

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

function node() {
  const listeners = {};
  return {
    dataset: {}, children: [], value: '', textContent: '', hidden: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    insertRow() { return { insertCell: () => ({}) }; },
    setAttribute() {}, querySelectorAll: () => [],
    addEventListener(type, callback) { listeners[type] = callback; }
  };
}

function recordingContext() {
  const calls = { ops: [], arc: [] };
  const recorded = ['clip', 'beginPath', 'stroke', 'closePath', 'fill'];
  const pathPoints = ['moveTo', 'lineTo'];
  const ignored = ['save', 'restore', 'rect', 'fillText', 'translate', 'rotate', 'setLineDash', 'setTransform', 'clearRect'];
  const context = { arc: x => calls.arc.push({ x }) };
  ignored.forEach(name => { context[name] = () => {}; });
  recorded.forEach(name => { context[name] = () => calls.ops.push({ name }); });
  pathPoints.forEach(name => { context[name] = (x, y) => calls.ops.push({ name, x, y }); });
  return { context, calls };
}

// splits: [[bucket start, { publicationIndex: views }]]; leave it undefined to mimic a response without the property.
function seriesFor(unit, from, to, points, publications, splits) {
  const series = {
    article: { id: ARTICLE_ID, title: 'Chart story' },
    unit, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    points: points.map(([time, views]) => ({ time: new Date(time).toISOString(), views })),
    publications: publications.map((publishedAt, index) => ({
      id: `p${index}`, kind: index === 0 ? 'initial' : 'update', publishedAt: new Date(publishedAt).toISOString(), views: 1
    }))
  };
  if (splits) {
    series.splits = splits.map(([time, byIndex]) => ({
      time: new Date(time).toISOString(),
      byPublication: Object.fromEntries(Object.entries(byIndex).map(([index, views]) => [`p${index}`, views]))
    }));
  }
  return series;
}

async function drawSeries(series) {
  const els = Object.fromEntries(['article-search', 'article-sort', 'search-status', 'article-results', 'analytics-panel', 'chart-title', 'range', 'chart-status', 'versions-body', 'analytics-signin']
    .map(id => [id, node()]));
  const { context, calls } = recordingContext();
  els['views-chart'] = Object.assign(node(), {
    clientWidth: CANVAS_WIDTH, clientHeight: CANVAS_HEIGHT, width: 0, height: 0, getContext: () => context
  });
  els.analytics = Object.assign(node(), { dataset: { timeZone: 'UTC', articleId: ARTICLE_ID } });
  els['article-sort'].value = 'default';
  const sandbox = {
    document: { getElementById: id => els[id], createElement: node },
    fetch: async url => ({
      ok: true, status: 200,
      json: async () => ({ data: url.includes('/views?') ? series : [] })
    }),
    history: { replaceState() {} }, ResizeObserver: class { observe() {} }, window: { devicePixelRatio: 1 },
    Intl, setTimeout, clearTimeout
  };
  vm.runInNewContext(script, sandbox);
  await flush();
  return calls;
}

function xAt(time) {
  return MARGIN_LEFT + ((time - FROM) / (TO - FROM)) * PLOT_WIDTH;
}

// The server reports 0 views for buckets that end before the first publication (20:40).
const VIEWS_PER_HOUR = [0, 0, 3, 4, 5, 6];
const hourlyViews = VIEWS_PER_HOUR.map((views, hour) => [FROM + hour * HOUR_MS, views]);

function yAt(views) {
  return BASELINE_Y - (views / Y_AXIS_MAX) * PLOT_HEIGHT;
}

// The views line is the moveTo/lineTo path after the clip call, up to the stroke that draws it.
function lineStrokeRange(calls) {
  const start = calls.ops.findIndex(op => op.name === 'clip');
  const stroke = calls.ops.findIndex((op, index) => index > start && op.name === 'stroke');
  return { start, stroke };
}

function polylineOf(calls) {
  const { start, stroke } = lineStrokeRange(calls);
  return calls.ops.slice(start + 1, stroke).filter(op => op.name === 'moveTo' || op.name === 'lineTo').map(({ x, y }) => ({ x, y }));
}

// The area fill continues the same path after the stroke and ends with fill.
function areaOf(calls) {
  const { stroke } = lineStrokeRange(calls);
  const fill = calls.ops.findIndex((op, index) => index > stroke && op.name === 'fill');
  return calls.ops.slice(stroke + 1, fill + 1);
}

const HOURLY_BUCKET_OF_MARKER = FROM + 2 * HOUR_MS;
const FIRST_MARKER_SPLITS = [[HOURLY_BUCKET_OF_MARKER, { 0: 3 }]];

test('no point with views is drawn left of the first publication marker', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, [PUBLISHED], FIRST_MARKER_SPLITS));
  const markerX = calls.arc[0].x;
  assert.equal(markerX, xAt(PUBLISHED));
  const raised = polylineOf(calls).filter(vertex => vertex.y < BASELINE_Y);
  assert.ok(raised.length > 0);
  raised.forEach(vertex => assert.ok(vertex.x >= markerX, `point at ${vertex.x} is left of marker ${markerX}`));
});

test('the line rises vertically exactly at the first publication marker', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, [PUBLISHED], FIRST_MARKER_SPLITS));
  const markerX = calls.arc[0].x;
  const line = polylineOf(calls);
  const flatIndex = line.findIndex(vertex => vertex.x === markerX);
  assert.ok(flatIndex > 0);
  assert.deepEqual(line[flatIndex], { x: markerX, y: BASELINE_Y });
  // The straddling bucket is 20:00-21:00, the third bucket, with 3 views.
  assert.deepEqual(line[flatIndex + 1], { x: markerX, y: yAt(3) });
  assertNoRampAcross(line, [markerX]);
  assert.equal(line[flatIndex - 1].y, BASELINE_Y);
});

test('a first publication exactly on a bucket boundary adds no extra point', async () => {
  const published = FROM + 2 * HOUR_MS;
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, [published]));
  assert.deepEqual(polylineOf(calls), hourlyViews.map(([time, views]) => ({ x: xAt(time), y: yAt(views) })));
});

test('buckets after the first publication stay at their bucket start position', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, [PUBLISHED], FIRST_MARKER_SPLITS));
  const line = polylineOf(calls);
  const expectedTail = hourlyViews.slice(3).map(([time, views]) => ({ x: xAt(time), y: yAt(views) }));
  assert.deepEqual(line.slice(-3), expectedTail);
  assert.equal(line.length, hourlyViews.length + 2);
});

function xInRange(from, to, time) {
  return MARGIN_LEFT + ((time - from) / (to - from)) * PLOT_WIDTH;
}

test('a first publication inside the first bucket starts the line flat at 0 from the bucket start', async () => {
  const from = Date.parse('2026-10-15T18:30:00.000Z');
  const to = Date.parse('2026-10-16T00:30:00.000Z');
  const published = Date.parse('2026-10-15T18:45:00.000Z');
  const bucketStart = Date.parse('2026-10-15T18:00:00.000Z');
  const views = [3, 4, 5, 6, 5, 4, 3];
  const points = views.map((count, hour) => [bucketStart + hour * HOUR_MS, count]);
  const calls = await drawSeries(seriesFor('hour', from, to, points, [published], [[bucketStart, { 0: 3 }]]));
  const markerX = xInRange(from, to, published);
  const line = polylineOf(calls);
  assert.equal(calls.arc[0].x, markerX);
  assert.deepEqual(line.slice(0, 3), [
    { x: xInRange(from, to, bucketStart), y: BASELINE_Y },
    { x: markerX, y: BASELINE_Y },
    { x: markerX, y: yAt(3) }
  ]);
  assert.ok(line[0].x < MARGIN_LEFT);
  line.filter(vertex => vertex.y < BASELINE_Y).forEach(vertex => assert.ok(vertex.x >= markerX, `point at ${vertex.x} is left of marker ${markerX}`));
});

test('with day buckets the line rises vertically at the marker inside a UTC day bucket', async () => {
  const from = Date.parse('2026-10-10T00:00:00.000Z');
  const to = Date.parse('2026-10-16T00:00:00.000Z');
  const published = Date.parse('2026-10-13T09:00:00.000Z');
  const dayViews = [0, 0, 0, 3, 4, 6];
  const points = dayViews.map((count, day) => [from + day * 24 * HOUR_MS, count]);
  const calls = await drawSeries(seriesFor('day', from, to, points, [published], [[from + 3 * 24 * HOUR_MS, { 0: 3 }]]));
  const markerX = xInRange(from, to, published);
  const line = polylineOf(calls);
  const flatIndex = line.findIndex(vertex => vertex.x === markerX);
  assert.deepEqual(line[flatIndex], { x: markerX, y: BASELINE_Y });
  assert.deepEqual(line[flatIndex + 1], { x: markerX, y: yAt(3) });
  assert.equal(line.length, dayViews.length + 2);
  line.filter(vertex => vertex.y < BASELINE_Y).forEach(vertex => assert.ok(vertex.x >= markerX, `point at ${vertex.x} is left of marker ${markerX}`));
});

test('a first publication older than the range adds no extra vertices', async () => {
  const published = FROM - 2 * HOUR_MS - 50 * 60 * 1000;
  const allViews = [2, 3, 4, 5, 6, 6];
  const points = allViews.map((count, hour) => [FROM + hour * HOUR_MS, count]);
  const calls = await drawSeries(seriesFor('hour', FROM, TO, points, [published], []));
  assert.deepEqual(polylineOf(calls), points.map(([time, count]) => ({ x: xAt(time), y: yAt(count) })));
  assert.equal(calls.arc.length, 0);
});

test('without publications every point stays at its bucket start position', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, []));
  assert.deepEqual(polylineOf(calls), hourlyViews.map(([time, views]) => ({ x: xAt(time), y: yAt(views) })));
});

test('the area fill closes down to the baseline at the last and first point, then fills', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, hourlyViews, [PUBLISHED], FIRST_MARKER_SPLITS));
  const line = polylineOf(calls);
  assert.deepEqual(areaOf(calls), [
    { name: 'lineTo', x: line[line.length - 1].x, y: BASELINE_Y },
    { name: 'lineTo', x: line[0].x, y: BASELINE_Y },
    { name: 'closePath' },
    { name: 'fill' }
  ]);
});

// Update markers: version 1 went live before the range, so the 20:00 bucket is shared by the versions live during it.
const FIRST_LIVE = FROM - 2 * HOUR_MS;
const SHARED_BUCKET = FROM + 2 * HOUR_MS;
const SECOND_PUBLISHED = Date.parse('2026-10-15T20:40:00.000Z');
const THIRD_PUBLISHED = Date.parse('2026-10-15T20:50:00.000Z');
const UPDATE_VIEWS = [2, 3, 5, 4, 5, 6];
const updateHourly = UPDATE_VIEWS.map((views, hour) => [FROM + hour * HOUR_MS, views]);

// A segment that changes height must not span a marker: the line steps vertically at the marker instead of ramping.
function assertNoRampAcross(line, markerXs) {
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    if (a.y === b.y) continue;
    markerXs.forEach(markerX => assert.ok(!(Math.min(a.x, b.x) < markerX && markerX < Math.max(a.x, b.x)), `segment ${i} ramps across marker at ${markerX}`));
  }
}

test('an update marker inside a bucket keeps the old version flat, then steps vertically at the marker', async () => {
  const splits = [[SHARED_BUCKET, { 0: 2, 1: 3 }]];
  const calls = await drawSeries(seriesFor('hour', FROM, TO, updateHourly, [FIRST_LIVE, SECOND_PUBLISHED], splits));
  const markerX = xAt(SECOND_PUBLISHED);
  assert.equal(calls.arc[0].x, markerX);
  assert.deepEqual(polylineOf(calls), [
    { x: xAt(FROM), y: yAt(2) },
    { x: xAt(FROM + HOUR_MS), y: yAt(3) },
    { x: xAt(SHARED_BUCKET), y: yAt(2) },
    { x: markerX, y: yAt(2) },
    { x: markerX, y: yAt(3) },
    { x: xAt(FROM + 3 * HOUR_MS), y: yAt(4) },
    { x: xAt(FROM + 4 * HOUR_MS), y: yAt(5) },
    { x: xAt(FROM + 5 * HOUR_MS), y: yAt(6) }
  ]);
});

test('the line does not ramp across an update marker', async () => {
  const splits = [[SHARED_BUCKET, { 0: 2, 1: 3 }]];
  const calls = await drawSeries(seriesFor('hour', FROM, TO, updateHourly, [FIRST_LIVE, SECOND_PUBLISHED], splits));
  assertNoRampAcross(polylineOf(calls), [xAt(SECOND_PUBLISHED)]);
});

test('two update markers inside one bucket give each version its own flat step', async () => {
  const secondX = xAt(SECOND_PUBLISHED);
  const thirdX = xAt(THIRD_PUBLISHED);
  const points = [[FROM, 1], [FROM + HOUR_MS, 1], [SHARED_BUCKET, 6], [FROM + 3 * HOUR_MS, 4]];
  const splits = [[SHARED_BUCKET, { 0: 1, 1: 2, 2: 3 }]];
  const calls = await drawSeries(seriesFor('hour', FROM, TO, points, [FIRST_LIVE, SECOND_PUBLISHED, THIRD_PUBLISHED], splits));
  const line = polylineOf(calls);
  assert.deepEqual(line.slice(2), [
    { x: xAt(SHARED_BUCKET), y: yAt(1) },
    { x: secondX, y: yAt(1) },
    { x: secondX, y: yAt(2) },
    { x: thirdX, y: yAt(2) },
    { x: thirdX, y: yAt(3) },
    { x: xAt(FROM + 3 * HOUR_MS), y: yAt(4) }
  ]);
  assertNoRampAcross(line, [secondX, thirdX]);
});

test('an update marker exactly on a bucket boundary adds no vertices', async () => {
  const published = FROM + 3 * HOUR_MS;
  const calls = await drawSeries(seriesFor('hour', FROM, TO, updateHourly, [FIRST_LIVE, published], []));
  assert.deepEqual(polylineOf(calls), updateHourly.map(([time, views]) => ({ x: xAt(time), y: yAt(views) })));
});

test('a response without splits still draws the plain bucket-start line when no marker lies inside a bucket', async () => {
  const calls = await drawSeries(seriesFor('hour', FROM, TO, updateHourly, [FIRST_LIVE]));
  assert.deepEqual(polylineOf(calls), updateHourly.map(([time, views]) => ({ x: xAt(time), y: yAt(views) })));
});

test('a first publication inside a bucket with no views keeps the line flat at 0 up to the marker, with no ramp across it', async () => {
  const markerX = xAt(PUBLISHED);
  const points = [[FROM, 0], [FROM + HOUR_MS, 0], [FROM + 2 * HOUR_MS, 0], [FROM + 3 * HOUR_MS, 4], [FROM + 4 * HOUR_MS, 5], [FROM + 5 * HOUR_MS, 6]];
  const calls = await drawSeries(seriesFor('hour', FROM, TO, points, [PUBLISHED], []));
  assert.equal(calls.arc[0].x, markerX);
  const line = polylineOf(calls);
  assert.deepEqual(line, [
    { x: xAt(FROM), y: BASELINE_Y },
    { x: xAt(FROM + HOUR_MS), y: BASELINE_Y },
    { x: xAt(FROM + 2 * HOUR_MS), y: BASELINE_Y },
    { x: markerX, y: BASELINE_Y },
    { x: markerX, y: BASELINE_Y },
    { x: xAt(FROM + 3 * HOUR_MS), y: yAt(4) },
    { x: xAt(FROM + 4 * HOUR_MS), y: yAt(5) },
    { x: xAt(FROM + 5 * HOUR_MS), y: yAt(6) }
  ]);
  assertNoRampAcross(line, [markerX]);
  line.filter(vertex => vertex.y < BASELINE_Y).forEach(vertex => assert.ok(vertex.x > markerX, `point at ${vertex.x} is left of marker ${markerX}`));
});

test('an update marker inside a bucket with no views and no split draws no ramp across it', async () => {
  const markerX = xAt(SECOND_PUBLISHED);
  const points = [[FROM, 2], [FROM + HOUR_MS, 3], [SHARED_BUCKET, 0], [FROM + 3 * HOUR_MS, 4], [FROM + 4 * HOUR_MS, 5], [FROM + 5 * HOUR_MS, 6]];
  const calls = await drawSeries(seriesFor('hour', FROM, TO, points, [FIRST_LIVE, SECOND_PUBLISHED], []));
  assert.equal(calls.arc[0].x, markerX);
  const line = polylineOf(calls);
  assert.deepEqual(line, [
    { x: xAt(FROM), y: yAt(2) },
    { x: xAt(FROM + HOUR_MS), y: yAt(3) },
    { x: xAt(SHARED_BUCKET), y: BASELINE_Y },
    { x: markerX, y: BASELINE_Y },
    { x: markerX, y: BASELINE_Y },
    { x: xAt(FROM + 3 * HOUR_MS), y: yAt(4) },
    { x: xAt(FROM + 4 * HOUR_MS), y: yAt(5) },
    { x: xAt(FROM + 5 * HOUR_MS), y: yAt(6) }
  ]);
  assertNoRampAcross(line, [markerX]);
});
