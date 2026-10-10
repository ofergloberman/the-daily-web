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
  const state = { cursor: feed.dataset.nextCursor || null, loading: false, generation: 0, controller: null, seen: new Set() };
  feed.querySelectorAll('.article-card').forEach(card => state.seen.add(card.dataset.id));

  document.getElementById('feed-apply').hidden = true;
  const moreLink = document.getElementById('feed-more');
  if (moreLink) moreLink.hidden = 'IntersectionObserver' in window;

  function params() {
    const data = new FormData(form);
    return { q: String(data.get('q') || '').trim(), category: String(data.get('category') || ''), sort: String(data.get('sort') || 'date') };
  }

  function setStatus(text, retry) {
    status.textContent = text;
    status.className = retry ? 'feed-status notice notice-error' : 'feed-status';
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.textContent = 'Try again';
      button.addEventListener('click', retry);
      status.append(' ', button);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
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
    if (article.category) body.append(element('p', 'card-category', article.category));
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

  function showEmpty({ q, category }) {
    const box = element('div', 'empty-state');
    box.append(element('h2', '', q || category ? 'No matching articles' : 'No articles yet'));
    box.append(element('p', '', q || category ? 'Try another search or category.' : 'Published stories will appear here.'));
    feed.append(box);
  }

  async function load(reset) {
    if (!reset && (state.loading || !state.cursor)) return;
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
      setStatus('Could not load articles.', () => load(reset));
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        feed.removeAttribute('aria-busy');
        if (moreLink && !state.cursor) moreLink.remove();
        if (state.cursor && sentinel.getBoundingClientRect().top < innerHeight + PRELOAD_PX) load(false);
      }
    }
  }

  function applyFilters() {
    const current = params();
    const query = new URLSearchParams(Object.entries(current).filter(([key, value]) => value && !(key === 'sort' && value === 'date')));
    history.replaceState(null, '', query.toString() ? `/?${query}` : '/');
    window.scrollTo({ top: 0 });
    load(true);
  }

  let searchTimer;
  form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); applyFilters(); });
  form.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, SEARCH_DELAY_MS); });
  form.category.addEventListener('change', applyFilters);
  form.sort.addEventListener('change', applyFilters);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(false); }, { rootMargin: `0px 0px ${PRELOAD_PX}px 0px` }).observe(sentinel);
  } else if (moreLink) {
    moreLink.addEventListener('click', event => { event.preventDefault(); load(false); });
  }
})();
