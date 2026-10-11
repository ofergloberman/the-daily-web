// Homepage feed: AJAX search/filter/sort and infinite scroll over GET /articles.
// The server-rendered page already holds the first 20 articles; this script only adds to it.
(() => {
  const form = document.getElementById('feed-controls');
  const feed = document.getElementById('feed');
  const sentinel = document.getElementById('feed-sentinel');
  const status = document.getElementById('feed-status');
  if (!form || !feed || !sentinel || !window.fetch) return;

  const SEARCH_DELAY_MS = 300;
  const PRELOAD_PX = 600;
  const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Jerusalem' });
  // failed stops automatic loading after an error until the reader retries or changes the filters.
  const state = { cursor: feed.dataset.nextCursor || null, loading: false, failed: false, generation: 0, controller: null, seen: new Set() };
  feed.querySelectorAll('.article-card').forEach(card => state.seen.add(card.dataset.id));

  status.tabIndex = -1; // Focus target after "Try again" removes its own button.
  document.getElementById('feed-apply').hidden = true;
  const moreLink = document.getElementById('feed-more');
  if (moreLink) moreLink.hidden = 'IntersectionObserver' in window;

  function params() {
    const data = new FormData(form);
    return { q: String(data.get('q') || '').trim(), category: String(data.get('category') || ''), sort: String(data.get('sort') || 'date'), viewed: String(data.get('viewed') || 'all') };
  }

  function setStatus(text, retry) {
    status.textContent = text;
    status.className = retry ? 'feed-status notice notice-error' : 'feed-status';
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.textContent = 'Try again';
      button.addEventListener('click', () => { state.failed = false; status.focus(); retry(); });
      status.append(' ', button);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // "Politics, Viewed" for screen readers; the comma is visually hidden.
  function viewedBadge() {
    const badge = element('span', 'viewed-badge');
    badge.append(element('span', 'visually-hidden', ', '), 'Viewed');
    return badge;
  }

  // Same markup as views/partials/articleCard.ejs. Text goes in through textContent, never innerHTML.
  function card(article) {
    const root = element('article', 'article-card');
    root.dataset.id = article.id;
    if (article.imageUrl) {
      const img = element('img', 'card-image');
      img.src = article.imageUrl; img.alt = ''; img.loading = 'lazy';
      root.append(img);
    }
    const body = element('div', 'card-body');
    if (article.category || article.viewed) {
      const label = element('p', 'card-category', article.category);
      if (article.viewed) label.append(viewedBadge());
      body.append(label);
    }
    const title = element('h2', 'card-title');
    const link = element('a', '', article.title || 'Untitled article');
    link.href = `/articles/${encodeURIComponent(article.id)}`;
    title.append(link);
    body.append(title);
    if (article.summary) body.append(element('p', 'card-summary', article.summary));
    const meta = element('p', 'card-meta', article.author || 'Staff');
    const time = element('time', '', dateFormat.format(new Date(article.publishedAt)));
    time.dateTime = article.publishedAt;
    meta.append(' · ', time);
    body.append(meta);
    root.append(body);
    return root;
  }

  function showEmpty({ q, category, viewed }) {
    const filtered = q || category || viewed !== 'all';
    const nothingViewed = viewed === 'viewed' && !q && !category;
    const box = element('div', 'empty-state');
    box.append(element('h2', '', nothingViewed ? 'Nothing viewed yet' : filtered ? 'No matching articles' : 'No articles yet'));
    box.append(element('p', '', nothingViewed ? 'Articles you open on this device will appear here.' : filtered ? 'Try another search, category or view filter.' : 'Published stories will appear here.'));
    feed.append(box);
  }

  // Returns the in-flight page request, so callers can wait for it without starting a second one.
  function load(reset) {
    if (!reset && state.loading) return state.pending;
    if (!reset && (state.failed || !state.cursor)) return Promise.resolve();
    state.pending = fetchPage(reset);
    return state.pending;
  }

  async function fetchPage(reset) {
    state.failed = false;
    if (reset) {
      state.controller?.abort();
      state.cursor = null;
    }
    const generation = ++state.generation;
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    feed.setAttribute('aria-busy', 'true');
    setStatus(reset ? 'Loading articles…' : 'Loading more articles…');
    const current = params();
    const query = new URLSearchParams(current);
    if (state.cursor) query.set('cursor', state.cursor);
    try {
      const response = await fetch(`/articles?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const body = await response.json();
      if (generation !== state.generation) return; // A newer search replaced this one.
      if (!response.ok) throw new Error(body.message || 'Request failed');
      if (reset) { feed.replaceChildren(); state.seen.clear(); }
      for (const article of body.data) {
        if (state.seen.has(article.id)) continue; // Popularity can shift between pages; never show an article twice.
        state.seen.add(article.id);
        feed.append(card(article));
      }
      if (!feed.children.length) showEmpty(current);
      state.cursor = body.pagination.hasMore ? body.pagination.nextCursor : null;
      setStatus(!state.cursor && state.seen.size ? 'You have reached the end of the feed.' : '');
    } catch (error) {
      if (error.name === 'AbortError' || generation !== state.generation) return;
      if (reset) { feed.replaceChildren(); state.seen.clear(); } // Never show old results under new filters.
      state.failed = true;
      setStatus('Could not load articles.', () => load(reset));
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        feed.removeAttribute('aria-busy');
        if (moreLink && !state.cursor) moreLink.remove();
        if (state.cursor && !state.failed && sentinel.getBoundingClientRect().top < innerHeight + PRELOAD_PX) load(false);
      }
    }
  }

  // Each applied filter gets its own history entry, so Back returns to the previous results.
  function applyFilters() {
    clearTimeout(searchTimer);
    const current = params();
    const query = new URLSearchParams(Object.entries(current).filter(([key, value]) => value && !(key === 'sort' && value === 'date') && !(key === 'viewed' && value === 'all')));
    const url = query.toString() ? `/?${query}` : '/';
    if (url !== location.pathname + location.search) history.pushState(null, '', url);
    window.scrollTo({ top: 0 });
    load(true);
  }

  function restoreFromUrl() {
    const query = new URLSearchParams(location.search);
    form.q.value = query.get('q') || '';
    form.category.value = query.get('category') || '';
    form.sort.value = query.get('sort') || 'date';
    form.viewed.value = query.get('viewed') || 'all';
    load(true);
  }

  let searchTimer;
  form.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  window.addEventListener('popstate', restoreFromUrl);
  form.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, SEARCH_DELAY_MS); });
  form.category.addEventListener('change', applyFilters);
  form.sort.addEventListener('change', applyFilters);
  form.viewed.addEventListener('change', applyFilters);
  // Coming Back from an article shows an old copy of this page: the whole page kept in memory
  // (pageshow.persisted), or the cached first-page HTML, which browsers reuse for history navigation
  // even with no-cache. Instead of reloading from the top, mark the articles opened from here and,
  // for the cached HTML, load the batches the reader had and return to their scroll position.
  const RETURN_KEY = 'feed:return';
  const MAX_OPENED = 200;
  function readReturn() {
    try { return JSON.parse(window.sessionStorage.getItem(RETURN_KEY)) || null; } catch { return null; }
  }
  feed.addEventListener('click', event => {
    const cardEl = event.target?.closest?.('.article-card');
    if (!cardEl || !event.target.closest('a')) return;
    const opened = [...new Set([...(readReturn()?.opened || []), cardEl.dataset.id])].slice(-MAX_OPENED);
    try {
      window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ search: location.search, count: state.seen.size, scrollY: window.scrollY, opened }));
    } catch { /* Storage blocked: Back simply shows the page as the browser kept it. */ }
  });

  function markOpened(opened) {
    const ids = new Set(opened);
    const hideViewed = params().viewed === 'unviewed';
    for (const cardEl of feed.querySelectorAll('.article-card')) {
      if (!ids.has(cardEl.dataset.id)) continue;
      if (hideViewed) { cardEl.remove(); continue; }
      if (cardEl.querySelector('.viewed-badge')) continue;
      let label = cardEl.querySelector('.card-category');
      if (!label) {
        label = element('p', 'card-category');
        cardEl.querySelector('.card-body').prepend(label);
      }
      label.append(viewedBadge());
    }
    if (hideViewed && !feed.querySelector('.article-card')) showEmpty(params());
  }

  async function restoreReturn(keptInMemory) {
    const saved = readReturn();
    if (!saved || saved.search !== location.search) return;
    markOpened(saved.opened);
    if (keptInMemory) return; // Batches and scroll position are already as the reader left them.
    while (state.cursor && !state.failed && state.seen.size < saved.count) await load(false);
    markOpened(saved.opened);
    window.scrollTo(0, saved.scrollY);
  }
  window.addEventListener('pageshow', event => { if (event.persisted) restoreReturn(true); });
  if (window.performance?.getEntriesByType?.('navigation')[0]?.type === 'back_forward') restoreReturn(false);

  if (!state.cursor && state.seen.size) setStatus('You have reached the end of the feed.');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(false); }, { rootMargin: `0px 0px ${PRELOAD_PX}px 0px` }).observe(sentinel);
  } else if (moreLink) {
    moreLink.addEventListener('click', event => { event.preventDefault(); load(false); });
  }
})();
