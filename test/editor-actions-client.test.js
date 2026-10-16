// Runs public/editor-actions.js in a VM with small DOM fakes to check the review-page behaviour without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/editor-actions.js'), 'utf8');
const ARTICLE_URL = '/editor/articles/abc123';

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => '<html></html>' });
const refreshed = () => reply(200, {});

function page({ responses, confirm = true }) {
  const calls = [];
  const listeners = {};
  const buttons = [{ disabled: false }, { disabled: false }];
  const status = { textContent: '', className: '', hidden: true };
  const signIn = { hidden: true };
  const note = { value: '' };
  const content = { replacedWith: null, replaceWith(node) { this.replacedWith = node; } };
  const freshContent = { fresh: true };
  const location = { assigned: null, reloaded: false, assign(url) { this.assigned = url; }, reload() { this.reloaded = true; } };
  const root = { dataset: { articleId: 'abc123' }, addEventListener: (type, callback) => { listeners[type] = callback; }, querySelectorAll: () => buttons };
  const elements = { review: root, 'action-status': status, 'action-signin': signIn, 'return-note': note, 'review-content': content };
  const queue = [...responses];
  const context = {
    TypeError,
    document: { getElementById: id => elements[id] },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body, buttonsDisabled: buttons.every(button => button.disabled) });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    DOMParser: class { parseFromString() { return { getElementById: () => freshContent }; } },
    FormData: class { constructor(form) { this.fields = form.fields; } [Symbol.iterator]() { return Object.entries(this.fields)[Symbol.iterator](); } },
    window: { confirm: () => confirm, location }
  };
  vm.runInNewContext(script, context);
  return {
    calls, status, signIn, note, content, freshContent, location, buttons,
    async click(action) {
      listeners.click({ target: { closest: () => ({ dataset: { action } }) } });
      await flush();
    },
    async submitEdit(fields) {
      const event = { target: { id: 'edit-form', fields }, preventDefault() { event.prevented = true; } };
      listeners.submit(event);
      await flush();
      return event;
    }
  };
}

test('approve posts to the article, locks the buttons meanwhile and swaps in the refreshed review', async () => {
  const view = page({ responses: [reply(200, { data: { id: 'abc123', status: 'published' } }), refreshed()] });
  await view.click('approve');
  assert.deepEqual(view.calls.map(({ method, url }) => [method, url]), [['POST', `${ARTICLE_URL}/approve`], ['GET', ARTICLE_URL]]);
  assert.equal(view.calls[0].buttonsDisabled, true, 'buttons are disabled while the request runs');
  assert.equal(view.content.replacedWith, view.freshContent);
  assert.match(view.status.textContent, /Approved/);
  assert.equal(view.status.hidden, false);
  assert.equal(view.status.className, 'notice');
  assert.ok(view.buttons.every(button => !button.disabled));
});

test('the page reloads when the refreshed review cannot be fetched after a successful action', async () => {
  const view = page({ responses: [reply(200, { data: {} }), reply(500, {})] });
  await view.click('approve');
  assert.equal(view.location.reloaded, true);
  assert.equal(view.content.replacedWith, null);
});

test('return needs a note and sends it trimmed', async () => {
  const view = page({ responses: [reply(200, { data: {} }), refreshed()] });
  view.note.value = '   ';
  await view.click('return');
  assert.equal(view.calls.length, 0, 'nothing is sent without a note');
  assert.match(view.status.textContent, /correction note/);
  assert.equal(view.status.className, 'notice notice-error');

  view.note.value = ' Add a source. ';
  await view.click('return');
  assert.equal(view.calls[0].method, 'POST');
  assert.equal(view.calls[0].url, `${ARTICLE_URL}/return`);
  assert.deepEqual(JSON.parse(view.calls[0].body), { note: 'Add a source.' });
});

test('delete asks for confirmation and only then removes the article and leaves the page', async () => {
  const declined = page({ responses: [], confirm: false });
  await declined.click('delete');
  assert.equal(declined.calls.length, 0);
  assert.equal(declined.location.assigned, null);

  const confirmed = page({ responses: [reply(200, { data: { id: 'abc123' } })] });
  await confirmed.click('delete');
  assert.deepEqual(confirmed.calls.map(({ method, url }) => [method, url]), [['DELETE', ARTICLE_URL]]);
  assert.equal(confirmed.location.assigned, '/editor');
});

test('saving the edit form sends the fields with PATCH and does not submit the page', async () => {
  const view = page({ responses: [reply(200, { data: {} }), refreshed()] });
  const event = await view.submitEdit({ title: 'New title', body: 'New body' });
  assert.equal(event.prevented, true);
  assert.equal(view.calls[0].method, 'PATCH');
  assert.equal(view.calls[0].url, ARTICLE_URL);
  assert.deepEqual(JSON.parse(view.calls[0].body), { title: 'New title', body: 'New body' });
  assert.match(view.status.textContent, /Changes saved/);
});

test('server rejections show their message, skip the refresh and unlock the buttons', async () => {
  const view = page({ responses: [reply(409, { error: 'INVALID_TRANSITION', message: 'This article was already handled by another request.' })] });
  await view.click('approve');
  assert.equal(view.status.textContent, 'This article was already handled by another request.');
  assert.equal(view.status.className, 'notice notice-error');
  assert.equal(view.calls.length, 1);
  assert.equal(view.content.replacedWith, null);
  assert.ok(view.buttons.every(button => !button.disabled));
});

test('an ended session and an unreachable server get clear messages', async () => {
  const expired = page({ responses: [reply(401, { error: 'AUTH_REQUIRED' })] });
  await expired.click('approve');
  assert.match(expired.status.textContent, /session has ended/);

  const offline = page({ responses: [new TypeError('Failed to fetch')] });
  await offline.click('approve');
  assert.match(offline.status.textContent, /could not be reached/);
});

test('clicks outside the action buttons are ignored', async () => {
  const view = page({ responses: [] });
  await view.click('unknown-action');
  assert.equal(view.calls.length, 0);
});
