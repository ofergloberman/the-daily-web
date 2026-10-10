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

test('a stale save conflict merges field-by-field: a locally edited field is kept and resent, but an untouched field adopts the newer session\'s value instead of overwriting it', async () => {
  const pageLoadDraft = { title: 'Original title', summary: 'Original summary', body: 'Original body', category: 'World', imageUrl: '' };
  const listeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(pageLoadDraft).map(([key, value]) => [key, { value }])),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const requests = [];
  let call = 0;
  let scheduledSave;
  // Another session concurrently changed `category` - a field this tab never
  // touched - and advanced the draft to version 5.
  const remoteDraft = { ...pageLoadDraft, category: 'Science' };
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
      if (call === 1) return { ok: false, status: 409, json: async () => ({ error: 'STALE_DRAFT', latest: { draftVersion: 5, draft: remoteDraft } }) };
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 6 } }) };
    }
  });

  // This tab only edits the title.
  form.elements.title.value = 'Still typing a new headline';
  listeners.input();
  await scheduledSave();
  // Let the conflict handler's auto-retry settle.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 2);
  // First attempt: this tab's only local edit, against the version it started from.
  assert.deepEqual(JSON.parse(requests[0].body), { ...pageLoadDraft, title: 'Still typing a new headline', baseVersion: 0 });
  // Retry: the locally-edited title is preserved and resent, but category -
  // never touched in this tab - adopts the other session's newer value
  // rather than this tab silently reverting it back to the stale copy.
  assert.deepEqual(JSON.parse(requests[1].body), { ...remoteDraft, title: 'Still typing a new headline', baseVersion: 5 });
  // The merged, non-conflicting field is reflected back into the form too.
  assert.equal(form.elements.category.value, 'Science');
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

test('a save error during submission stops the retry loop instead of retrying forever', async () => {
  const draft = { title: 'Draft', summary: 'S', body: 'B', category: 'World', imageUrl: '' };
  const listeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft', submitUrl: '/reporter/articles/example/submit', draftVersion: '0' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const submitButtonListeners = {};
  const submitButton = { disabled: false, addEventListener: (name, callback) => { submitButtonListeners[name] = callback; } };
  const submitStatus = { textContent: '' };
  let callCount = 0;
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({
        'draft-form': form, 'save-status': status, 'retry-save': retry,
        'submit-button': submitButton, 'submit-status': submitStatus
      })[id],
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async () => { callCount += 1; throw new Error('Network down'); }
  });

  listeners.input();
  await submitButtonListeners.click();

  // Before the fix, flush()'s loop never advanced savedVersion nor halted on
  // an ordinary save error, so it retried the same failing save forever.
  // It must now stop after the first failure and let the retry UI take over.
  assert.equal(callCount, 1);
  assert.equal(status.parentElement.dataset.state, 'error');
  assert.equal(submitStatus.textContent, 'Network down');
  assert.equal(submitButton.disabled, false);
});

test('pagehide sends a fresh keepalive request with the latest edits even while another save is already in flight', async () => {
  const draft = { title: 'First', summary: 'S', body: 'B', category: 'World', imageUrl: '' };
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
  let scheduledSave;
  let releaseFirst;
  const firstRequestHeld = new Promise(resolve => { releaseFirst = resolve; });
  runInNewContext(SCRIPT, {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry })[id],
      addEventListener() {}
    },
    window: { addEventListener: (name, callback) => { windowListeners[name] = callback; } },
    setTimeout: callback => { scheduledSave = callback; return 1; },
    clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push(options);
      if (requests.length === 1) { await firstRequestHeld; return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 1 } }) }; }
      return { ok: true, status: 200, json: async () => ({ article: { draftVersion: 2 } }) };
    }
  });

  listeners.input();
  // Started but deliberately not awaited: the mocked fetch above blocks on
  // `firstRequestHeld`, simulating a slow in-flight save.
  scheduledSave();
  assert.equal(requests.length, 1);

  // More typing happens while that save is still in flight.
  form.elements.title.value = 'Second edit made while the first save is still pending';
  listeners.input();
  windowListeners.pagehide();

  // Before the fix, pagehide's save({keepalive:true}) would just return the
  // in-flight (non-keepalive) promise unchanged, so this newer edit would
  // never be sent before the page is gone. A second, independent keepalive
  // request must be dispatched instead.
  assert.equal(requests.length, 2);
  assert.equal(requests[1].keepalive, true);
  assert.deepEqual(JSON.parse(requests[1].body), { ...draft, title: 'Second edit made while the first save is still pending', baseVersion: 0 });

  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
});


