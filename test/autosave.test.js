const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

const SCRIPT = readFileSync(require.resolve('../public/reporter-autosave.js'), 'utf8');

test('autosave preserves article text and an unfinished URL without form validation blocking it', async () => {
  const draft = { title: 'Latest title', summary: '', body: 'Unsaved writing', category: '', imageUrl: 'https://' };
  const listeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    reportValidity: () => false,
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const requests = [];
  let scheduledSave;
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry })[id],
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setTimeout: callback => { scheduledSave = callback; return 1; },
    clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push(options);
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 1 } }) };
    }
  });
  listeners.input();
  await scheduledSave();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0].body), { ...draft, baseVersion: 0 });
  assert.equal(status.textContent, 'Saved');
});

test('typing immediately before refresh or close is flushed through a keepalive request, not left to the debounce timer', async () => {
  const draft = { title: 'Breaking', summary: 'S', body: 'B', category: 'World', imageUrl: '' };
  const listeners = {};
  const windowListeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const requests = [];
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry })[id],
      addEventListener() {}
    },
    window: { addEventListener: (name, callback) => { windowListeners[name] = callback; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push(options);
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 1 } }) };
    }
  });

  listeners.input();
  // The 800ms debounce has not fired yet - this is the exact "typed, then
  // immediately closed/refreshed" window the autosave must still cover.
  assert.equal(requests.length, 0);
  windowListeners.pagehide();
  // The fetch call happens synchronously up to its first await, so it has
  // already been dispatched by the time the (necessarily synchronous) unload
  // handler returns - a real browser can then keep it alive past unload.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].keepalive, true);
  assert.deepEqual(JSON.parse(requests[0].body), { ...draft, baseVersion: 0 });
  await new Promise(resolve => setImmediate(resolve));
});

test('a stale save conflict resyncs the version and retries, never silently dropping the typed text', async () => {
  const draft = { title: 'Still typing', summary: 'S', body: 'B', category: 'World', imageUrl: '' };
  const listeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const requests = [];
  let call = 0;
  let scheduledSave;
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry })[id],
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setTimeout: callback => { scheduledSave = callback; return 1; },
    clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push(options);
      call += 1;
      if (call === 1) return { ok: false, status: 409, json: async () => ({ error: 'STALE_DRAFT', latest: { draftVersion: 5 } }) };
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 6 } }) };
    }
  });

  listeners.input();
  await scheduledSave();
  // Let the auto-retry the conflict handler queues settle.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].body), { ...draft, baseVersion: 0 });
  assert.deepEqual(JSON.parse(requests[1].body), { ...draft, baseVersion: 5 });
  assert.equal(status.textContent, 'Saved');
});

test('clicking away flushes a pending save before navigating, so a debounced keystroke is never lost', async () => {
  const draft = { title: 'About to navigate away', summary: 'S', body: 'B', category: 'World', imageUrl: '' };
  const listeners = {};
  const backLinkListeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const backLink = { href: '/reporter', addEventListener: (name, callback) => { backLinkListeners[name] = callback; } };
  const locationUpdates = [];
  const requests = [];
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry, 'back-link': backLink })[id],
      addEventListener() {}
    },
    window: { addEventListener() {}, location: { set href(value) { locationUpdates.push(value); } } },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push(options);
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 1 } }) };
    }
  });

  listeners.input();
  // The debounce timer is stubbed to never fire on its own - only the flush
  // triggered by the click below should save this keystroke.
  let defaultPrevented = false;
  await backLinkListeners.click({ preventDefault: () => { defaultPrevented = true; } });

  assert.equal(defaultPrevented, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].body), { ...draft, baseVersion: 0 });
  assert.deepEqual(locationUpdates, ['/reporter']);
});

