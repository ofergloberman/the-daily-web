// Runs public/analytics.js in a VM with small DOM fakes to check the article picker without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/analytics.js'), 'utf8');

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

function node() {
  const listeners = {};
  return {
    dataset: {}, children: [], value: '', textContent: '', hidden: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {}, querySelectorAll: () => [],
    addEventListener(type, callback) { listeners[type] = callback; },
    dispatch(type, event = {}) { return listeners[type]?.(event); }
  };
}

function page(articles) {
  const els = Object.fromEntries(['article-search', 'article-sort', 'search-status', 'article-results', 'analytics-panel', 'chart-title', 'range', 'chart-status', 'views-chart', 'versions-body']
    .map(id => [id, node()]));
  els.analytics = Object.assign(node(), { dataset: { timeZone: 'UTC', articleId: '' } });
  els['article-sort'].value = 'default';
  const urls = [];
  const context = {
    document: { getElementById: id => els[id], createElement: node },
    fetch: async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: articles }) }; },
    history: { replaceState() {} }, ResizeObserver: class { observe() {} }, window: {},
    Intl, setTimeout, clearTimeout
  };
  vm.runInNewContext(script, context);
  return { els, urls };
}

const article = { id: 'a1', title: 'Most read story', publishedAt: '2026-10-01T10:00:00.000Z', totalViews: 1234 };

test('the picker loads the default order first and shows each article\'s total views', async () => {
  const { els, urls } = page([article]);
  await flush();
  assert.deepEqual(urls, ['/analytics/articles?q=&sort=default']);
  assert.match(els['article-results'].children[0].children[0].textContent, /Most read story .* 1,234 total views$/);
});

test('changing the sort asks the server for that order, keeping the search text', async () => {
  const { els, urls } = page([article]);
  await flush();
  els['article-search'].value = 'budget vote';
  els['article-sort'].value = 'popular';
  els['article-sort'].dispatch('change');
  await flush();
  assert.equal(urls.at(-1), '/analytics/articles?q=budget%20vote&sort=popular');
  assert.equal(els['article-results'].children.length, 1);
});
