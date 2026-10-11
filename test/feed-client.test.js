// Runs public/feed.js in a VM with small DOM fakes to check its loading rules without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/feed.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function node(tag = 'div') {
  const listeners = {};
  const el = {
    tag, children: [], dataset: {}, className: '', hidden: false, value: '', _text: '',
    get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; },
    remove() { el.removed = true; },
    querySelectorAll() { return []; },
    setAttribute(name, value) { this[`attr:${name}`] = value; },
    removeAttribute(name) { delete this[`attr:${name}`]; },
    getBoundingClientRect() { return { top: 0 }; }, // The sentinel is always in view.
    focus() { el.focused = true; },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    dispatch(type, event = {}) { (listeners[type] || []).forEach(callback => callback({ preventDefault() {}, ...event })); }
  };
  return el;
}

function page({ cursor = 'cursor-1', fetch }) {
  const feed = node('section');
  feed.dataset.nextCursor = cursor;
  const form = node('form');
  form.q = node('input'); form.category = node('select'); form.sort = node('select');
  form.sort.value = 'date';
  const els = { 'feed-controls': form, feed, 'feed-sentinel': node(), 'feed-status': node('p'), 'feed-apply': node('button'), 'feed-more': null };
  let observer;
  const history = { entries: [], pushState(_s, _t, url) { this.entries.push(url); context.location.search = url.slice(1); } };
  const context = {
    document: { getElementById: id => els[id], createElement: node },
    fetch, history, location: { pathname: '/', search: '' }, innerHeight: 800,
    FormData: class { constructor(f) { this.f = f; } get(name) { return this.f[name].value; } },
    IntersectionObserver: class { constructor(callback) { observer = () => callback([{ isIntersecting: true }]); } observe() {} },
    AbortController, URLSearchParams, Intl, setTimeout, clearTimeout,
    scrollTo() {}, addEventListener() {}
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { feed, form, status: els['feed-status'], scroll: () => observer(), history };
}

const article = id => ({ id, title: `Title ${id}`, summary: '', category: '', imageUrl: '', author: 'A', publishedAt: '2026-10-01T10:00:00.000Z' });
const ok = (data, nextCursor = null) => ({ ok: true, json: async () => ({ data, pagination: { nextCursor, hasMore: Boolean(nextCursor) } }) });

test('a failed scroll load waits for "Try again" instead of retrying in a loop', async () => {
  const calls = [];
  const view = page({ fetch: async url => { calls.push(url); if (calls.length === 1) throw new TypeError('offline'); return ok([article('a2')]); } });
  view.scroll();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(calls.length, 1, 'no automatic retry after an error');
  assert.match(view.status.textContent, /Could not load articles\. Try again/);
  view.scroll();
  await flush();
  assert.equal(calls.length, 1, 'scrolling again does not retry either');

  const retry = view.status.children.find(child => typeof child === 'object');
  retry.dispatch('click');
  assert.ok(view.status.focused, 'focus moves to the status, not lost with the removed button');
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /cursor=cursor-1/);
  assert.equal(view.feed.children.length, 1);
});

test('only the newest search may replace the feed, and the older request is aborted', async () => {
  const pending = [];
  const view = page({ cursor: '', fetch: (url, { signal }) => new Promise(resolve => pending.push({ url, signal, resolve })) });
  view.form.q.value = 'old';
  view.form.dispatch('submit');
  view.form.q.value = 'new';
  view.form.dispatch('submit');
  assert.equal(pending.length, 2);
  assert.ok(pending[0].signal.aborted);
  pending[1].resolve(ok([article('new-1')]));
  for (let i = 0; i < 5; i++) await flush();
  pending[0].resolve(ok([article('old-1'), article('old-2')]));
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(view.feed.children.map(card => card.dataset.id), ['new-1']);
  assert.deepEqual(view.history.entries, ['/?q=old', '/?q=new'], 'each applied search gets a history entry');
});

test('no duplicate request while loading, and no duplicate cards across pages', async () => {
  const pending = [];
  const view = page({ fetch: url => new Promise(resolve => pending.push({ url, resolve })) });
  view.scroll();
  view.scroll();
  assert.equal(pending.length, 1, 'second scroll while loading is ignored');
  pending[0].resolve(ok([article('a'), article('b')], 'cursor-2'));
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(pending.length, 2, 'sentinel still in view, so the next page loads');
  pending[1].resolve(ok([article('b'), article('c')]));
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(view.feed.children.map(card => card.dataset.id), ['a', 'b', 'c']);
  assert.match(view.status.textContent, /reached the end/);
});
