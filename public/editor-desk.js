// Editor desk: AJAX title search, status filter and paging over GET /editor/articles.
// The server-rendered page already shows the first results; this script only upgrades the form and links.
(() => {
  const form = document.getElementById('desk-search');
  const searchInput = document.getElementById('desk-q');
  const clearLink = document.getElementById('desk-clear');
  const filter = document.getElementById('desk-filter');
  const list = document.getElementById('desk-list');
  const pager = document.getElementById('desk-pager');
  const status = document.getElementById('desk-status');
  if (!form || !searchInput || !clearLink || !filter || !list || !pager || !status || !window.fetch) return;

  const SEARCH_DELAY_MS = 300;
  const DESK_PATH = '/editor';
  const LIST_PATH = '/editor/articles';
  // state is what the reader asked for last; generation lets a late response recognise it is out of date.
  let state = readDeskState(location.search);
  let generation = 0;
  let controller = null;
  let searchTimer;

  function readDeskState(search) {
    const params = new URLSearchParams(search);
    return { q: params.get('q') || '', status: params.get('status') || '', page: Number(params.get('page')) || 1 };
  }

  // Empty values are left out and page 1 is the default, so the address stays short.
  function buildDeskUrl(path, { q, status: statusValue, page }) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (statusValue) params.set('status', statusValue);
    if (page > 1) params.set('page', page);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }

  async function fetchDeskPage(target, signal) {
    const response = await fetch(buildDeskUrl(LIST_PATH, target), { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) throw new Error('Your session has ended. Sign in again as an editor.');
    if (!response.ok) throw new Error(body.message || 'Could not load articles.');
    return body.data;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Same markup as views/editor/dashboard.ejs. Text goes in through textContent, never innerHTML.
  function renderRow(row) {
    const heading = element('h2', 'editor-row-title');
    const link = element('a', '', row.title);
    link.href = `/editor/articles/${encodeURIComponent(row.id)}`;
    heading.append(link);
    const time = element('time', '', row.updatedLabel);
    time.dateTime = row.updatedAt;
    const meta = element('p', 'card-meta', `By ${row.authorName} · Updated `);
    meta.append(time);
    const main = element('div', 'editor-row-main');
    main.append(heading, meta);
    const side = element('div', 'editor-row-status');
    side.append(element('span', `status-badge status-${row.status}`, row.statusLabel));
    if (row.isPublishedUpdate) side.append(element('span', 'status-note', 'Update to a published article'));
    const root = element('article', 'editor-row');
    root.append(main, side);
    return root;
  }

  function renderEmpty({ q, status: statusValue, page }) {
    const box = element('div', 'empty-state');
    if (page > 1) {
      box.append(element('h2', '', 'No articles found'), element('p', '', 'There are no more articles.'));
    } else if (q) {
      const clear = element('a', 'desk-link', 'Clear search');
      clear.href = buildDeskUrl(DESK_PATH, { status: statusValue });
      clear.dataset.clear = '';
      box.append(element('h2', '', `No articles match \u201c${q}\u201d`), element('p', '', 'Try a different part of the title.'), clear);
    } else {
      box.append(element('h2', '', 'No articles found'), element('p', '', 'There are no articles with this status yet.'));
    }
    return box;
  }

  function renderRows(target, rows) {
    list.replaceChildren(...(rows.length ? rows.map(renderRow) : [renderEmpty(target)]));
  }

  function pagerLink(target, page, text) {
    const link = element('a', 'desk-link', text);
    link.href = buildDeskUrl(DESK_PATH, { ...target, page });
    link.dataset.page = String(page);
    return link;
  }

  function renderPager(target, hasNext, rowCount) {
    const items = [];
    if (target.page > 1) items.push(pagerLink(target, target.page - 1, 'Previous page'));
    items.push(element('span', '', `Page ${target.page}`));
    if (hasNext) items.push(pagerLink(target, target.page + 1, 'Next page'));
    pager.replaceChildren(...items);
    pager.hidden = !rowCount && target.page === 1;
  }

  // Chips keep the typed search and change only the status; the current one is marked.
  function renderControls(target) {
    clearLink.hidden = !target.q;
    clearLink.href = buildDeskUrl(DESK_PATH, { status: target.status });
    filter.querySelectorAll('.desk-chip').forEach(chip => {
      chip.href = buildDeskUrl(DESK_PATH, { q: target.q, status: chip.dataset.status });
      if (chip.dataset.status === target.status) chip.setAttribute('aria-current', 'page');
      else chip.removeAttribute('aria-current');
    });
  }

  function renderStatus(message, isError = false) {
    status.textContent = message;
    status.className = isError ? 'feed-status notice notice-error' : 'feed-status';
  }

  function describeResults(count, page) {
    if (!count) return 'No articles found.';
    return `${count} article${count === 1 ? '' : 's'} on page ${page}.`;
  }

  async function loadDesk(target) {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const current = ++generation;
    state = target;
    history.replaceState(null, '', buildDeskUrl(DESK_PATH, target));
    renderControls(target);
    list.setAttribute('aria-busy', 'true');
    renderStatus('Loading articles\u2026');
    try {
      const { articles, hasNext } = await fetchDeskPage(target, request.signal);
      if (current !== generation) return;
      renderRows(target, articles);
      renderPager(target, hasNext, articles.length);
      renderStatus(describeResults(articles.length, target.page));
    } catch (error) {
      if (error.name === 'AbortError' || current !== generation) return;
      renderStatus(error instanceof TypeError ? 'The server could not be reached. Try again.' : error.message, true);
    } finally {
      if (current === generation) list.removeAttribute('aria-busy');
    }
  }

  // A new search always starts on page 1 and keeps the chosen status.
  function runSearch() {
    clearTimeout(searchTimer);
    loadDesk({ q: searchInput.value.trim(), status: state.status, page: 1 });
  }

  function targetForLink(link) {
    if (link.dataset.page) {
      // Text typed after the last load has not been searched yet, so the page link starts that search on page 1.
      if (searchInput.value.trim() !== state.q) return { q: searchInput.value.trim(), status: state.status, page: 1 };
      return { ...state, page: Number(link.dataset.page) };
    }
    if ('clear' in link.dataset) {
      searchInput.value = '';
      return { q: '', status: state.status, page: 1 };
    }
    return { q: searchInput.value.trim(), status: link.dataset.status, page: 1 };
  }

  function isModifiedClick(event) {
    return event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function onLinkClick(event) {
    const link = event.target.closest('.desk-link');
    if (!link || isModifiedClick(event)) return;
    event.preventDefault();
    clearTimeout(searchTimer);
    if (link.dataset.page) window.scrollTo({ top: 0 });
    loadDesk(targetForLink(link));
  }

  function bindDeskEvents() {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      runSearch();
    });
    document.addEventListener('click', onLinkClick);
  }

  bindDeskEvents();
})();
