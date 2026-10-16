// Runs public/editor-desk.js in a VM with small DOM fakes to check the Editor desk search without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/editor-desk.js'), 'utf8');
const SEARCH_DELAY_MS = 300;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function node(tag = 'div', className = '') {
  const listeners = {};
  const hasClass = (el, name) => el.className.split(' ').includes(name);
  const el = {
    tag, className, children: [], dataset: {}, hidden: false, value: '', href: '', parent: null, attrs: {}, _text: '',
    get textContent() { return this._text + this.children.map(child => child.textContent ?? child).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error('innerHTML must never be used with article data'); },
    append(...items) { for (const item of items) { if (typeof item === 'object') item.parent = el; this.children.push(item); } },
    replaceChildren(...items) { this.children = []; this.append(...items); },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    closest(selector) { let at = el; while (at && !hasClass(at, selector.slice(1))) at = at.parent; return at; },
    find(predicate) { return predicate(el) ? el : el.children.filter(c => typeof c === 'object').map(c => c.find(predicate)).find(Boolean) ?? null; },
    findAll(predicate) { return [...(predicate(el) ? [el] : []), ...el.children.filter(c => typeof c === 'object').flatMap(c => c.findAll(predicate))]; },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    dispatch(type, event = {}) {
      const received = { preventDefault() { received.prevented = true; }, ...event };
      (listeners[type] || []).forEach(callback => callback(received));
      return received;
    }
  };
  return el;
}

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const row = (id, overrides = {}) => ({
  id, title: `Title ${id}`, authorName: 'Dana', updatedAt: '2026-10-02T10:00:00.000Z', updatedLabel: 'Oct 2, 2026',
  status: 'pending', statusLabel: 'Pending approval', isPublishedUpdate: false, ...overrides
});
const ok = (articles, hasNext = false) => reply(200, { data: { articles, page: 1, hasNext } });

function page({ search = '', fetch }) {
  const els = {
    'desk-search': node('form'), 'desk-q': node('input'), 'desk-clear': node('a', 'desk-link desk-clear'),
    'desk-filter': node('nav'), 'desk-list': node('section'), 'desk-pager': node('nav'), 'desk-status': node('p'), 'desk-signin': node('a')
  };
  els['desk-clear'].hidden = true;
  els['desk-signin'].hidden = true;
  const chips = ['', 'draft', 'pending'].map(value => { const chip = node('a', 'desk-link desk-chip'); chip.dataset.status = value; return chip; });
  els['desk-filter'].querySelectorAll = selector => (selector === '.desk-chip' ? chips : []);
  const timers = [];
  const history = { replaced: [], replaceState(_state, _title, url) { this.replaced.push(url); } };
  const scrolls = [];
  const documentListeners = {};
  const context = {
    document: {
      getElementById: id => els[id], createElement: node,
      addEventListener: (type, callback) => { (documentListeners[type] ||= []).push(callback); }
    },
    fetch, history, location: { search }, AbortController, URLSearchParams, Error, TypeError,
    scrollTo: options => scrolls.push(options),
    setTimeout: (callback, ms) => { timers.push({ callback, ms, active: true }); return timers.length - 1; },
    clearTimeout: id => { if (timers[id]) timers[id].active = false; }
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const view = {
    els, chips, history, scrolls, timers,
    input: els['desk-q'], list: els['desk-list'], pager: els['desk-pager'], status: els['desk-status'], clear: els['desk-clear'],
    type(value) { view.input.value = value; view.input.dispatch('input'); },
    activeTimers: () => timers.filter(timer => timer.active),
    async fireTimer() { timers.filter(timer => timer.active).at(-1).callback(); await flush(); },
    click(target, event = {}) { const received = { target, preventDefault() { received.prevented = true; }, ...event }; documentListeners.click.forEach(callback => callback(received)); return received; },
    titles: () => view.list.findAll(el => el.className === 'editor-row-title').map(el => el.textContent)
  };
  return view;
}

test('typing waits for a pause, trims, resets to page 1, keeps the status and leaves empty values out of the URLs', async () => {
  const calls = [];
  const view = page({ search: '?q=old&status=pending&page=3', fetch: async url => { calls.push(url); return ok([row('a')]); } });
  view.type('new');
  view.type('new  ');
  assert.equal(view.activeTimers().length, 1, 'a newer keystroke cancels the earlier timer');
  assert.equal(view.activeTimers()[0].ms, SEARCH_DELAY_MS);
  assert.equal(calls.length, 0, 'nothing is requested until the pause');
  await view.fireTimer();
  assert.deepEqual(calls, ['/editor/articles?q=new&status=pending']);
  assert.deepEqual(view.history.replaced, ['/editor?q=new&status=pending']);
  assert.equal(view.clear.hidden, false);
  assert.equal(view.clear.href, '/editor?status=pending');
  assert.equal(view.chips[0].href, '/editor?q=new');
  assert.equal(view.chips[1].href, '/editor?q=new&status=draft');
  assert.equal(view.chips[2].attrs['aria-current'], 'page');
  assert.equal(view.chips[1].attrs['aria-current'], undefined);

  view.type('   ');
  await view.fireTimer();
  assert.equal(calls[1], '/editor/articles?status=pending');
  assert.equal(view.history.replaced[1], '/editor?status=pending');
  assert.equal(view.clear.hidden, true);
});

test('with no search, no status and page 1 the URLs are the plain desk and list paths', async () => {
  const calls = [];
  const view = page({ fetch: async (url, options) => { calls.push({ url, options }); return ok([]); } });
  view.els['desk-search'].dispatch('submit');
  await flush();
  assert.equal(calls[0].url, '/editor/articles');
  assert.deepEqual(view.history.replaced, ['/editor']);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('rows are built as text: a script title becomes plain text and no element', async () => {
  const hostile = '<script>alert(1)</script>';
  const view = page({ fetch: async () => ok([row('abc', { title: hostile, authorName: '<b>Dana</b>', isPublishedUpdate: true, status: 'published', statusLabel: 'Published' })]) });
  view.type('x');
  await view.fireTimer();
  assert.deepEqual(view.titles(), [hostile]);
  assert.equal(view.list.find(el => el.tag === 'script'), null);
  assert.equal(view.list.find(el => el.tag === 'b'), null);
  const link = view.list.find(el => el.tag === 'a');
  assert.equal(link.href, '/editor/articles/abc');
  assert.equal(view.list.find(el => el.className === 'card-meta').textContent, 'By <b>Dana</b> · Updated Oct 2, 2026');
  const time = view.list.find(el => el.tag === 'time');
  assert.equal(time.dateTime, '2026-10-02T10:00:00.000Z');
  assert.ok(view.list.find(el => el.className === 'status-badge status-published'));
  assert.equal(view.list.find(el => el.className === 'status-note').textContent, 'Update to a published article');
  assert.equal(view.status.textContent, '1 article on page 1.');
});

test('an aborted or older response never replaces the newer rows', async () => {
  const pending = [];
  const view = page({ fetch: (url, { signal }) => new Promise(resolve => pending.push({ url, signal, resolve })) });
  view.type('old');
  await view.fireTimer();
  view.type('new');
  await view.fireTimer();
  assert.equal(pending.length, 2);
  assert.ok(pending[0].signal.aborted, 'the previous request is cancelled');
  pending[1].resolve(ok([row('new-1')]));
  await flush();
  assert.equal(view.list.attrs['aria-busy'], undefined);
  pending[0].resolve(ok([row('old-1'), row('old-2')]));
  await flush();
  assert.deepEqual(view.titles(), ['Title new-1']);
  assert.equal(view.status.textContent, '1 article on page 1.');
});

test('the list is marked busy while loading and a stale response does not clear the flag early', async () => {
  const pending = [];
  const view = page({ fetch: () => new Promise(resolve => pending.push(resolve)) });
  view.type('a');
  await view.fireTimer();
  view.type('ab');
  await view.fireTimer();
  assert.equal(view.list.attrs['aria-busy'], 'true');
  assert.equal(view.status.textContent, 'Loading articles\u2026');
  pending[0](ok([row('old')]));
  await flush();
  assert.equal(view.list.attrs['aria-busy'], 'true', 'the newer request is still running');
  pending[1](ok([row('new')]));
  await flush();
  assert.equal(view.list.attrs['aria-busy'], undefined);
});

test('a cancelled request that rejects with AbortError shows no error', async () => {
  const view = page({ fetch: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) });
  view.type('a');
  await view.fireTimer();
  view.type('ab');
  await view.fireTimer();
  assert.equal(view.status.textContent, 'Loading articles\u2026');
  assert.notEqual(view.status.className, 'feed-status notice notice-error');
});

test('failures are shown in the status line and keep the current rows', async () => {
  const responses = [ok([row('keep')]), reply(400, { error: 'INVALID_SEARCH', message: 'Search must be at most 100 characters.' }), reply(403, { error: 'FORBIDDEN' }), new TypeError('offline')];
  const view = page({ fetch: async () => { const next = responses.shift(); if (next instanceof Error) throw next; return next; } });
  view.type('a');
  await view.fireTimer();
  view.type('b');
  await view.fireTimer();
  assert.equal(view.status.textContent, 'Search must be at most 100 characters.');
  assert.equal(view.status.className, 'feed-status notice notice-error');
  assert.deepEqual(view.titles(), ['Title keep']);
  view.type('c');
  await view.fireTimer();
  assert.match(view.status.textContent, /session has ended/);
  view.type('d');
  await view.fireTimer();
  assert.match(view.status.textContent, /could not be reached/);
  assert.equal(view.list.attrs['aria-busy'], undefined);
});

test('status chips keep the typed search and load without a reload; modified clicks are left to the browser', async () => {
  const calls = [];
  const view = page({ search: '?page=2', fetch: async url => { calls.push(url); return ok([row('a')]); } });
  view.input.value = 'united';
  const plain = view.click(view.chips[1]);
  await flush();
  assert.ok(plain.prevented);
  assert.deepEqual(calls, ['/editor/articles?q=united&status=draft']);
  const modified = view.click(view.chips[2], { ctrlKey: true });
  assert.equal(modified.prevented, undefined);
  assert.equal(calls.length, 1);
  assert.equal(view.click(node('span')).prevented, undefined, 'clicks outside desk links are ignored');
});

test('pager links keep the search and status, and the pager is rebuilt from the response', async () => {
  const calls = [];
  const view = page({ search: '?q=united&status=pending', fetch: async url => { calls.push(url); return ok([row('a')], calls.length === 1); } });
  view.type('united');
  await view.fireTimer();
  const next = view.pager.find(el => el.tag === 'a');
  assert.equal(next.textContent, 'Next page');
  assert.equal(next.href, '/editor?q=united&status=pending&page=2');
  assert.equal(view.pager.hidden, false);

  view.click(next);
  await flush();
  assert.equal(calls[1], '/editor/articles?q=united&status=pending&page=2');
  assert.equal(view.scrolls.length, 1);
  assert.equal(view.scrolls[0].top, 0);
  assert.equal(view.history.replaced.at(-1), '/editor?q=united&status=pending&page=2');
  assert.deepEqual(view.pager.children.map(child => child.textContent), ['Previous page', 'Page 2']);
  assert.equal(view.pager.children[0].href, '/editor?q=united&status=pending');
});

test('a page link clicked while a typed search is still pending runs that search on page 1', async () => {
  const calls = [];
  const view = page({ fetch: async url => { calls.push(url); return ok([row('a')], true); } });
  view.type('uni');
  await view.fireTimer();
  view.type('unit');
  assert.equal(view.activeTimers().length, 1, 'the search for "unit" is still pending');
  view.click(view.pager.find(el => el.tag === 'a'));
  await flush();
  assert.equal(view.activeTimers().length, 0, 'the pending timer is cancelled');
  assert.deepEqual(calls, ['/editor/articles?q=uni', '/editor/articles?q=unit']);
  assert.equal(view.history.replaced.at(-1), '/editor?q=unit');
});

test('no results for a search shows the quoted term as text with a Clear search link that restores the list', async () => {
  const calls = [];
  const view = page({ search: '?status=draft', fetch: async url => { calls.push(url); return ok(calls.length === 1 ? [] : [row('a')]); } });
  view.type('<i>zzz</i>');
  await view.fireTimer();
  const empty = view.list.find(el => el.className === 'empty-state');
  assert.equal(empty.find(el => el.tag === 'h2').textContent, 'No articles match \u201c<i>zzz</i>\u201d');
  assert.equal(empty.find(el => el.tag === 'i'), null);
  assert.equal(view.pager.hidden, true);
  assert.equal(view.status.textContent, 'No articles found.');

  const clear = empty.find(el => el.className === 'desk-link');
  assert.equal(clear.textContent, 'Clear search');
  assert.equal(clear.href, '/editor?status=draft');
  view.click(clear);
  await flush();
  assert.equal(view.input.value, '');
  assert.equal(calls[1], '/editor/articles?status=draft');
  assert.deepEqual(view.titles(), ['Title a']);
});
