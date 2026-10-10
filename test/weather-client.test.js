const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const path = require('node:path');

const START = Date.parse('2026-10-10T12:00:00Z');
const script = fs.readFileSync(path.join(__dirname, '../public/weather.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function browser() {
  let elapsed = 0;
  const timers = new Map();
  const elements = Object.fromEntries(['message', 'details', 'location', 'temperature', 'condition', 'time']
    .map(name => [name, { hidden: name === 'details', textContent: '' }]));
  const documentEvents = {};
  const windowEvents = {};
  const calls = [];
  const state = { failure: false, stall: false, remaining: 60000, dataAge: 840000 };
  const document = { hidden: false,
    getElementById: () => ({ querySelector: selector => elements[selector.match(/data-weather-(\w+)/)[1]] }),
    addEventListener: (name, handler) => { documentEvents[name] = handler; } };
  vm.runInNewContext(script, { document, window: {
    addEventListener: (name, handler) => { windowEvents[name] = handler; }
  }, Date: class extends Date { static now() { return START + 86400000 + elapsed; } },
  performance: { now: () => elapsed }, AbortController,
  setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, at: elapsed + delay }); return id; },
  clearTimeout: id => timers.delete(id),
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (state.stall) return new Promise(() => {});
    if (state.failure) throw new Error('Offline');
    return { ok: true, headers: { get: () => new Date(START + elapsed).toISOString() }, json: async () => ({
      status: 'available', location: '<b>Tel Aviv</b>', temperatureC: 24, weatherCode: 0,
      dataTime: new Date(START + elapsed - state.dataAge).toISOString(),
      fetchedAt: new Date(START + elapsed).toISOString(),
      expiresAt: new Date(START + elapsed + state.remaining).toISOString()
    }) };
  } });
  return { elements, calls, state, document, documentEvents, windowEvents,
    async advance(ms) {
      elapsed += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= elapsed && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
      await flush();
    }, suspend(ms) { elapsed += ms; } };
}

test('widget renders safely with a skewed device clock and expires during a stalled refresh', async () => {
  const page = browser();
  await flush();
  assert.equal(page.calls[0].url, '/weather');
  assert.equal(page.calls[0].options.cache, 'no-store');
  assert.equal(page.elements.details.hidden, false);
  assert.equal(page.elements.location.textContent, '<b>Tel Aviv</b>');
  assert.equal(page.elements.temperature.textContent, '24 °C');
  page.state.stall = true;
  await page.advance(59999);
  assert.equal(page.elements.details.hidden, false);
  await page.advance(1);
  assert.equal(page.elements.details.hidden, true);
  assert.equal(page.elements.message.textContent, 'Weather is temporarily unavailable.');
  assert.equal(page.calls.length, 2);
});

test('background and back-forward pages hide data and refresh on return', async () => {
  const page = browser();
  await flush();
  page.document.hidden = true;
  page.documentEvents.visibilitychange();
  assert.equal(page.elements.details.hidden, true);
  page.document.hidden = false;
  page.documentEvents.visibilitychange();
  await flush();
  assert.equal(page.elements.details.hidden, false);
  page.windowEvents.pagehide();
  assert.equal(page.elements.details.hidden, true);
  page.windowEvents.pageshow();
  await flush();
  assert.equal(page.calls.length, 3);
});

test('focus checks freshness after timers were suspended and failures retry', async () => {
  const page = browser();
  await flush();
  page.suspend(61000);
  page.state.failure = true;
  page.windowEvents.focus();
  assert.equal(page.elements.details.hidden, true);
  await flush();
  page.state.failure = false;
  await page.advance(60000);
  assert.equal(page.elements.details.hidden, false);
});

test('client rejects stale data even when expiresAt claims a later expiry', async () => {
  const page = browser();
  await flush();
  page.state.dataAge = 900000;
  page.state.remaining = 300000;
  page.windowEvents.pageshow();
  await flush();
  assert.equal(page.elements.details.hidden, true);
});

test('a request completing after backgrounding cannot restore hidden conditions', async () => {
  const page = browser();
  page.document.hidden = true;
  page.documentEvents.visibilitychange();
  await flush();
  assert.equal(page.elements.details.hidden, true);
  page.document.hidden = false;
  page.documentEvents.visibilitychange();
  await flush();
  assert.equal(page.elements.details.hidden, false);
});

test('sidebar renders dedicated widget, hidden conditions, script and attribution', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/partials/sidebar.ejs'));
  assert.match(html, /id="weather-slot"/);
  assert.match(html, /data-weather-details hidden/);
  assert.match(html, /src="\/weather.js" defer/);
  assert.match(html, /href="https:\/\/open-meteo.com\/"/);
  assert.match(html, /creativecommons.org\/licenses\/by\/4.0/);
});
