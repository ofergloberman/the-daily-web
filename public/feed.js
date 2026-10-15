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
  // applied is what the feed currently shows; the form can be ahead of it while the reader is still typing.
  const state = { cursor: feed.dataset.nextCursor || null, loading: false, failed: false, generation: 0, controller: null, seen: new Set(), applied: null, search: location.search, typing: false };
  feed.querySelectorAll('.article-card').forEach(card => state.seen.add(card.dataset.id));

  status.tabIndex = -1; // Focus target after "Try again" removes its own button.
  document.getElementById('feed-apply').hidden = true;
  const moreLink = document.getElementById('feed-more');
  if (moreLink) moreLink.hidden = 'IntersectionObserver' in window;

  function params() {
    const data = new FormData(form);
    return { q: String(data.get('q') || '').trim(), category: String(data.get('category') || ''), sort: String(data.get('sort') || 'date'), viewed: String(data.get('viewed') || 'all') };
  }
  state.applied = params();

  function setStatus(text, retry) {
    state.errorShown = Boolean(retry);
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

  // One empty-state box at most, and only once nothing more can load.
  function syncEmpty() {
    feed.querySelectorAll('.empty-state').forEach(box => box.remove());
    if (!feed.querySelector('.article-card') && !state.cursor) showEmpty(state.applied);
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
    // Appending is shown by the dimmed list (aria-busy) and is not announced, so a screen reader hears
    // the result count of a new search instead of "loading" after every batch.
    if (reset) setStatus('Loading articles…');
    const query = new URLSearchParams(state.applied);
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
      state.cursor = body.pagination.hasMore ? body.pagination.nextCursor : null;
      syncEmpty();
      const count = state.seen.size;
      const end = !state.cursor && count ? 'You have reached the end of the feed.' : '';
      // After new filters, say how many results there are; appended batches stay quiet.
      const found = `${state.cursor ? `Showing the first ${count}` : count} article${count === 1 ? '' : 's'}.`;
      if (reset && count) setStatus(`${found} ${end}`.trim());
      else if (reset || end || state.errorShown) setStatus(end);
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

  // Each applied filter gets its own history entry, so Back returns to the previous results. While the
  // reader keeps typing, each pause replaces that entry instead of adding one per partial word.
  function applyFilters(fromTyping = false) {
    clearTimeout(searchTimer);
    state.applied = params();
    const query = new URLSearchParams(Object.entries(state.applied).filter(([key, value]) => value && !(key === 'sort' && value === 'date') && !(key === 'viewed' && value === 'all')));
    const url = query.toString() ? `/?${query}` : '/';
    if (url !== location.pathname + location.search) {
      if (fromTyping && state.typing) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
    }
    state.typing = fromTyping;
    state.search = location.search;
    window.scrollTo({ top: 0 });
    load(true);
  }

  function restoreFromUrl() {
    // Following an in-page link such as "Skip to content" also fires popstate; the filters did not change.
    if (location.search === state.search) return;
    clearTimeout(searchTimer);
    const query = new URLSearchParams(location.search);
    form.q.value = query.get('q') || '';
    form.category.value = query.get('category') || '';
    form.sort.value = query.get('sort') || 'date';
    form.viewed.value = query.get('viewed') || 'all';
    state.applied = params();
    state.search = location.search;
    state.typing = false;
    load(true);
  }

  let searchTimer;
  form.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  window.addEventListener('popstate', restoreFromUrl);
  form.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilters(true), SEARCH_DELAY_MS); });
  for (const control of [form.category, form.sort, form.viewed]) control.addEventListener('change', () => applyFilters());
  // Coming Back from an article shows an old copy of this page: the whole page kept in memory
  // (pageshow.persisted), or the cached first-page HTML, which browsers reuse for history navigation
  // even with no-cache. Instead of reloading from the top, mark the articles opened from here and,
  // for the cached HTML, load the batches the reader had and return to their scroll position.
  const RETURN_KEY = 'feed:return';
  const MAX_OPENED = 200;
  const ANCHORS = 6; // The opened card and the next few: whichever is still shown on return keeps the reader's place.
  function readReturn() {
    try { return JSON.parse(window.sessionStorage.getItem(RETURN_KEY)) || null; } catch { return null; }
  }
  feed.addEventListener('click', event => {
    const cardEl = event.target?.closest?.('.article-card');
    if (!cardEl || !event.target.closest('a')) return;
    const opened = [...new Set([...(readReturn()?.opened || []), cardEl.dataset.id])].slice(-MAX_OPENED);
    const cards = [...feed.querySelectorAll('.article-card')];
    const at = cards.indexOf(cardEl);
    const saved = { search: location.search, count: state.seen.size, scrollY: window.scrollY, anchors: cards.slice(at, at + ANCHORS).map(el => el.dataset.id), offset: cardEl.getBoundingClientRect().top, opened };
    try {
      window.sessionStorage.setItem(RETURN_KEY, JSON.stringify(saved));
    } catch {
      // Storage full or blocked: Back shows the page as the browser kept it, never an older saved position.
      try { window.sessionStorage.removeItem(RETURN_KEY); } catch { /* nothing to clear */ }
    }
  });

  function markOpened(opened) {
    const ids = new Set(opened);
    const hideViewed = state.applied.viewed === 'unviewed';
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
    if (hideViewed) {
      syncEmpty();
      if (!feed.querySelector('.article-card')) load(false); // Every card shown was read; fetch the next unread ones.
    }
  }

  function findAnchor(saved) {
    const cards = [...feed.querySelectorAll('.article-card')];
    for (const id of saved.anchors || []) {
      const found = cards.find(el => el.dataset.id === id);
      if (found) return found;
    }
    return null;
  }

  async function restoreReturn(keptInMemory) {
    const saved = readReturn();
    if (!saved || saved.search !== location.search) return;
    if (!keptInMemory) {
      // Reload the batches the reader had, stopping as soon as their place in the feed is back.
      while (state.cursor && !state.failed && state.seen.size < saved.count && !findAnchor(saved)) await load(false);
    }
    markOpened(saved.opened);
    // Scroll by the card the reader was at, not by pixels: under "Not viewed yet" cards above it may be gone.
    const anchor = findAnchor(saved);
    if (anchor) window.scrollTo(0, anchor.getBoundingClientRect().top + window.scrollY - (saved.offset || 0));
    else if (!keptInMemory) window.scrollTo(0, saved.scrollY);
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
