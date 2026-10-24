// Runs public/feed.js in a VM with small DOM fakes to check its loading rules without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/feed.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function node(tag = 'div', className = '') {
  const listeners = {};
  const hasClass = (el, name) => typeof el === 'object' && el.className.split(' ').includes(name);
  const all = (root, name) => root.children.flatMap(child => typeof child === 'object' ? [...(hasClass(child, name) ? [child] : []), ...all(child, name)] : []);
  const el = {
    tag, className, children: [], dataset: {}, hidden: false, value: '', _text: '', parent: null,
    get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; (this.texts ||= []).push(this._text); },
    append(...items) { for (const item of items) { if (typeof item === 'object') item.parent = el; this.children.push(item); } },
    prepend(item) { item.parent = el; this.children.unshift(item); },
    replaceChildren() { this.children = []; },
    remove() { el.removed = true; if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); },
    // Only ".class" selectors, which is all feed.js uses.
    querySelectorAll(selector) { return all(el, selector.slice(1)); },
    querySelector(selector) { return all(el, selector.slice(1))[0] || null; },
    closest(selector) { let at = el; while (at && !(selector === 'a' ? at.tag === 'a' : hasClass(at, selector.slice(1)))) at = at.parent; return at || null; },
    setAttribute(name, value) { this[`attr:${name}`] = value; },
    removeAttribute(name) { delete this[`attr:${name}`]; },
    getBoundingClientRect() { return { top: el.top ?? 0 }; }, // The sentinel is always in view; cards can set top.
    focus() { el.focused = true; },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    dispatch(type, event = {}) { (listeners[type] || []).forEach(callback => callback({ preventDefault() {}, ...event })); }
  };
  return el;
}

// A card as the server renders it: article.article-card > div.card-body > [p.card-category] h2 > a.
function serverCard(id, category = '') {
  const card = node('article', 'article-card');
  card.dataset.id = id;
  const body = node('div', 'card-body');
  if (category) { const label = node('p', 'card-category'); label.textContent = category; body.append(label); }
  const title = node('h2', 'card-title');
  title.append(node('a'));
  body.append(title);
  card.append(body);
  return card;
}

function page({ cursor = 'cursor-1', fetch, navigation = 'navigate', cards = [], viewed = 'all', search = '', stored = null }) {
  const feed = node('section');
  feed.dataset.nextCursor = cursor;
  feed.dataset.timeZone = 'Asia/Jerusalem';
  feed.append(...cards);
  const form = node('form');
  form.q = node('input'); form.category = node('select'); form.sort = node('select'); form.viewed = node('select');
  form.sort.value = 'date'; form.viewed.value = viewed;
  const els = { 'feed-controls': form, feed, 'feed-sentinel': node(), 'feed-status': node('p'), 'feed-apply': node('button'), 'feed-more': null };
  let observer;
  const windowListeners = {};
  const storage = new Map(stored ? [['feed:return', JSON.stringify(stored)]] : []);
  const scrolls = [];
  const history = {
    entries: [], replaced: [],
    pushState(_s, _t, url) { this.entries.push(url); context.location.search = url.slice(1); },
    replaceState(_s, _t, url) { this.replaced.push(url); context.location.search = url.slice(1); }
  };
  const context = {
    document: { getElementById: id => els[id], createElement: node },
    fetch, history, location: { pathname: '/', search }, innerHeight: 800, scrollY: 1234,
    FormData: class { constructor(f) { this.f = f; } get(name) { return this.f[name].value; } },
    IntersectionObserver: class { constructor(callback) { observer = () => callback([{ isIntersecting: true }]); } observe() {} },
    AbortController, URLSearchParams, Intl, setTimeout, clearTimeout,
    scrollTo(...args) { scrolls.push(args); },
    addEventListener(type, callback) { (windowListeners[type] ||= []).push(callback); },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (context.storageFull) throw new Error('QuotaExceededError'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    performance: { getEntriesByType: () => [{ type: navigation }] }
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return {
    feed, form, status: els['feed-status'], scroll: () => observer(), history, scrolls,
    stored: () => JSON.parse(storage.get('feed:return') || 'null'),
    pageshow: persisted => (windowListeners.pageshow || []).forEach(callback => callback({ persisted })),
    popstate: () => (windowListeners.popstate || []).forEach(callback => callback({})),
    context
  };
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

test('opening an article remembers it with the reader position', () => {
  const cards = ['p0', 'p1', 'p2'].map(id => serverCard(id));
  const view = page({ cards, fetch: async () => ok([]) });
  const link = cards[1].querySelector('.card-title').children[0];
  view.feed.dispatch('click', { target: link });
  assert.deepEqual(view.stored(), { search: '', count: 3, scrollY: 1234, anchors: ['p1', 'p2'], offset: 0, opened: ['p1'] });
  view.feed.dispatch('click', { target: cards[1] }); // a click on the card but not its link is ignored
  view.feed.dispatch('click', { target: cards[2].querySelector('.card-title').children[0] });
  assert.deepEqual(view.stored().opened, ['p1', 'p2']);
});

test('Back to the cached first page reloads the batches the reader had and restores scroll', async () => {
  const cards = Array.from({ length: 20 }, (_, i) => serverCard(`p${i}`, i === 3 ? 'World' : ''));
  const calls = [];
  const batches = [ok(Array.from({ length: 20 }, (_, i) => article(`q${i}`)), 'cursor-2'), ok(Array.from({ length: 5 }, (_, i) => article(`r${i}`)))];
  const view = page({
    cards, navigation: 'back_forward',
    stored: { search: '', count: 45, scrollY: 3000, opened: ['p3', 'p7', 'q2'] },
    fetch: async url => { calls.push(url); return batches[calls.length - 1]; }
  });
  for (let i = 0; i < 15; i++) await flush();
  assert.equal(calls.length, 2, 'two more batches, not a reload from the top');
  assert.match(calls[0], /cursor=cursor-1/);
  assert.equal(view.feed.querySelectorAll('.article-card').length, 45);
  const badged = view.feed.querySelectorAll('.article-card').filter(c => c.querySelector('.viewed-badge')).map(c => c.dataset.id);
  assert.deepEqual(badged, ['p3', 'p7', 'q2'], 'cached cards and reloaded cards opened earlier are marked');
  assert.match(view.feed.querySelectorAll('.article-card')[3].querySelector('.card-category').textContent, /^World, Viewed$/);
  assert.deepEqual(view.scrolls.at(-1), [0, 3000]);
});

test('Back from memory under "Not viewed yet" removes the article just read without any request', async () => {
  const calls = [];
  const cards = ['p0', 'p1', 'p2'].map(id => serverCard(id));
  const view = page({ cards, viewed: 'unviewed', search: '?viewed=unviewed', cursor: '', stored: { search: '?viewed=unviewed', count: 3, scrollY: 0, opened: ['p1'] }, fetch: async url => { calls.push(url); return ok([]); } });
  view.pageshow(false);
  assert.equal(view.feed.querySelectorAll('.article-card').length, 3, 'a normal page show changes nothing');
  view.pageshow(true);
  await flush();
  assert.deepEqual(view.feed.querySelectorAll('.article-card').map(c => c.dataset.id), ['p0', 'p2']);
  assert.equal(calls.length, 0);
});

test('Back is ignored when the saved state belongs to other filters or storage is empty', async () => {
  const calls = [];
  const cards = ['p0', 'p1'].map(id => serverCard(id));
  const view = page({ cards, navigation: 'back_forward', search: '?q=vote', stored: { search: '', count: 40, scrollY: 900, opened: ['p1'] }, fetch: async url => { calls.push(url); return ok([]); } });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(view.feed.querySelectorAll('.viewed-badge').length, 0);
  assert.deepEqual(view.scrolls, []);
  page({ navigation: 'back_forward', fetch: async url => { calls.push(url); return ok([]); } });
  await flush();
  assert.equal(calls.length, 0);
});

test('"Skip to content" (a same-page link firing popstate) never resets the feed; a real Back does', async () => {
  const calls = [];
  const view = page({ cards: ['p0', 'p1'].map(id => serverCard(id)), fetch: async url => { calls.push(url); return ok([article('n1')]); } });
  view.popstate(); // location.search is unchanged: only the #main fragment moved
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(view.feed.querySelectorAll('.article-card').length, 2);
  view.context.location.search = '?q=vote';
  view.popstate();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /q=vote/);
  assert.equal(view.form.q.value, 'vote');
});

test('typing pauses replace one history entry; a filter change adds a new one', async () => {
  const view = page({ cursor: '', fetch: async () => ok([article('a')]) });
  const wait = () => new Promise(resolve => setTimeout(resolve, 320));
  for (const text of ['ele', 'elect', 'election']) { view.form.q.value = text; view.form.q.dispatch('input'); await wait(); }
  assert.deepEqual(view.history.entries, ['/?q=ele']);
  assert.deepEqual(view.history.replaced, ['/?q=elect', '/?q=election']);
  view.form.sort.value = 'popular';
  view.form.sort.dispatch('change');
  assert.deepEqual(view.history.entries, ['/?q=ele', '/?q=election&sort=popular']);
});

test('scrolling while a search is still being typed keeps loading the search on screen', async () => {
  const calls = [];
  const view = page({ fetch: async url => { calls.push(url); return ok([article('m1')]); } });
  view.form.q.value = 'half-typed';
  view.form.q.dispatch('input'); // the 300 ms timer has not fired yet
  view.scroll();
  await flush();
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /half-typed/, 'the next page of the current results, not the unapplied text with their cursor');
});

test('a reset announces the result count; appended batches only announce the end', async () => {
  const responses = [ok([article('a'), article('b')], 'cursor-9'), ok([article('c')])];
  const view = page({ cursor: '', fetch: async () => responses.shift() });
  view.form.dispatch('submit');
  for (let i = 0; i < 10; i++) await flush();
  assert.deepEqual(view.status.texts.filter(Boolean), ['Loading articles…', 'Showing the first 2 articles.', 'You have reached the end of the feed.']);
});

test('Back under "Not viewed yet" with every shown card read fetches the next unread ones, with one empty box at most', async () => {
  const calls = [];
  const cards = ['p0', 'p1'].map(id => serverCard(id));
  const view = page({ cards, viewed: 'unviewed', search: '?viewed=unviewed', stored: { search: '?viewed=unviewed', count: 2, scrollY: 0, opened: ['p0', 'p1'] }, fetch: async url => { calls.push(url); return ok([article('u1')]); } });
  view.pageshow(true);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.length, 1, 'the cursor still has unread articles');
  assert.deepEqual(view.feed.querySelectorAll('.article-card').map(c => c.dataset.id), ['u1']);
  assert.equal(view.feed.querySelectorAll('.empty-state').length, 0);
});

test('Back scrolls to the card the reader was at, even when cards above it were removed', async () => {
  const cards = ['p0', 'p1', 'p2', 'p3'].map(id => serverCard(id));
  cards[3].top = 150; // where p3 sits now, after p1 and p2 left the "Not viewed yet" list
  const view = page({ cards, viewed: 'unviewed', search: '?viewed=unviewed', cursor: '', stored: { search: '?viewed=unviewed', count: 4, scrollY: 900, anchors: ['p2', 'p3'], offset: 40, opened: ['p1', 'p2'] }, fetch: async () => ok([]) });
  view.pageshow(true);
  await flush();
  assert.deepEqual(view.scrolls.at(-1), [0, 150 + 1234 - 40], 'p3 back at the height p2 had, not the old pixel offset');
});

test('when storage is full, an older saved position is cleared rather than restored later', () => {
  const cards = ['p0', 'p1'].map(id => serverCard(id));
  const view = page({ cards, stored: { search: '', count: 9, scrollY: 5000, opened: ['old'] }, fetch: async () => ok([]) });
  view.context.storageFull = true;
  view.feed.dispatch('click', { target: cards[1].querySelector('.card-title').children[0] });
  assert.equal(view.stored(), null);
});
