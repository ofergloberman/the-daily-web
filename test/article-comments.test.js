const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { formatDate } = require('../helpers/dates');

const script = fs.readFileSync(path.join(__dirname, '../public/article-comments.js'), 'utf8');
const malicious = '<img src=x onerror=alert(1)>';

function browser(fetch) {
  function element() {
    return {
      children: [], dataset: {}, value: '', textContent: '', hidden: false,
      classList: { toggle() {} },
      append(...children) { this.children.push(...children); },
      setAttribute() {}, removeAttribute() {}, focus() {}
    };
  }
  const list = element();
  const original = element();
  list.append(original);
  const empty = element();
  const message = element();
  const button = element();
  const name = element();
  name.value = 'Guest';
  const body = element();
  body.value = 'My comment';
  let submit;
  const form = {
    action: 'http://localhost/comments',
    elements: { namedItem: key => key === 'body' ? body : name },
    querySelector: () => button,
    addEventListener: (_event, callback) => { submit = callback; },
    setAttribute() {}, removeAttribute() {}
  };
  const section = {
    dataset: { articleId: 'article-id' },
    querySelector: selector => ({ form, '[data-comment-list]': list,
      '[data-comments-empty]': empty, '[data-comment-message]': message })[selector]
  };
  vm.runInNewContext(script, {
    document: { getElementById: () => section, createElement: element }, fetch, Intl
  });
  return { list, original, empty, message, button, name, body,
    submit: () => submit({ preventDefault() {} }) };
}

const comment = { id: 'saved-id', displayName: malicious, body: malicious, createdAt: '2026-10-10T12:00:00.000Z' };

test('partial renders existing comments escaped, empty state, and authenticated identity', async () => {
  const render = (comments, user = null) => ejs.renderFile(
    path.join(__dirname, '../views/partials/comments.ejs'),
    { comments, user, article: { _id: 'article-id' }, formatDate }
  );
  const html = await render([comment]);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-comments-empty hidden/);
  assert.match(html, /name="displayName"/);
  const empty = await render([]);
  assert.match(empty, /data-comments-empty>No comments yet/);
  assert.match(empty, /name="body"/);
  const authenticated = await render([], { displayName: malicious });
  assert.doesNotMatch(authenticated, /name="displayName"|<img/);
  assert.match(authenticated, /Commenting as/);
});

test('POST appends only the returned comment as text and blocks duplicate in-flight submissions', async () => {
  let resolve;
  const calls = [];
  const ui = browser((url, options) => {
    calls.push({ url, options });
    return new Promise(done => { resolve = done; });
  });
  const pending = ui.submit();
  assert.equal(ui.button.disabled, true);
  await ui.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { articleId: 'article-id', displayName: 'Guest', body: 'My comment' });
  resolve({ ok: true, json: async () => ({ comment }) });
  await pending;
  assert.equal(ui.list.children.length, 2);
  assert.equal(ui.list.children[0], ui.original);
  assert.equal(ui.list.children[1].children[0].textContent, malicious);
  assert.equal(ui.list.children[1].children[3].textContent, malicious);
  assert.equal(ui.empty.hidden, true);
  assert.equal(ui.body.value, '');
  assert.equal(ui.button.disabled, false);
  assert.match(ui.message.textContent, /was posted/);
});

test('validation, 429, server and network errors retain input and existing list', async t => {
  for (const status of [400, 429, 500, 'network']) {
    await t.test(String(status), async () => {
      const ui = browser(async () => {
        if (status === 'network') throw new Error('offline');
        return { ok: false, status, json: async () => ({ retryAfterSeconds: 12 }) };
      });
      await ui.submit();
      assert.equal(ui.body.value, 'My comment');
      assert.equal(ui.name.value, 'Guest');
      assert.equal(ui.list.children.length, 1);
      assert.equal(ui.list.children[0], ui.original);
      assert.equal(ui.button.disabled, false);
      assert.match(ui.message.textContent, status === 429 ? /12 seconds/ : /Check|kept/);
    });
  }
});

test('whitespace validation makes no request; edits during submission survive success', async () => {
  let calls = 0;
  let resolve;
  const ui = browser(() => { calls++; return new Promise(done => { resolve = done; }); });
  ui.body.value = '   ';
  await ui.submit();
  assert.equal(calls, 0);
  assert.match(ui.message.textContent, /Enter a name/);
  ui.body.value = 'First comment';
  const pending = ui.submit();
  ui.body.value = 'Next comment';
  resolve({ ok: true, json: async () => ({ comment }) });
  await pending;
  assert.equal(ui.body.value, 'Next comment');
});
