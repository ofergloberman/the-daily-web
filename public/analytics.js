(() => {
  const root = document.getElementById('analytics');
  if (!root) return;

  const HOUR_MS = 60 * 60 * 1000;
  const SEARCH_DELAY_MS = 250;
  const X_TICKS = 5;
  const Y_TICKS = 4;
  const X_TICK_ALIGN = { 0: 'left', [X_TICKS]: 'right' };
  const MARGIN = { top: 28, right: 20, bottom: 36, left: 52 };
  const COLORS = { line: '#155e96', fill: 'rgba(21, 94, 150, 0.12)', grid: '#d8e1e8', text: '#53677a', initial: '#2d6044', update: '#c2570c' };
  const KIND_LABELS = { initial: 'First publication', update: 'Approved update' };
  const timeZone = root.dataset.timeZone;

  const searchInput = document.getElementById('article-search');
  const searchStatus = document.getElementById('search-status');
  const results = document.getElementById('article-results');
  const panel = document.getElementById('analytics-panel');
  const chartTitle = document.getElementById('chart-title');
  const range = document.getElementById('range');
  const chartStatus = document.getElementById('chart-status');
  const canvas = document.getElementById('views-chart');
  const versionsBody = document.getElementById('versions-body');

  let selectedId = root.dataset.articleId;
  let searchRequest = 0;
  let seriesRequest = 0;
  let searchTimer;
  let currentSeries = null;

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) throw new Error('Your session has ended. Sign in again as an editor.');
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'The request failed. Try again.');
    return body.data;
  }

  function formatTime(value, options) {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(value));
  }

  function formatPublished(value) {
    return formatTime(value, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function tickLabel(ms, unit) {
    if (unit === 'minute') return formatTime(ms, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (unit === 'hour') return formatTime(ms, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ms));
  }

  function niceStep(rawStep) {
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const multiplier = [1, 2, 5, 10].find(candidate => rawStep / magnitude <= candidate);
    return Math.max(1, multiplier * magnitude);
  }

  function prepareCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function drawAxes(context, plot, scale, series) {
    context.font = '12px sans-serif';
    context.fillStyle = COLORS.text;
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let tick = 0; tick <= Y_TICKS; tick += 1) {
      const views = tick * scale.yStep;
      const y = scale.y(views);
      context.beginPath();
      context.moveTo(plot.left, y);
      context.lineTo(plot.left + plot.width, y);
      context.stroke();
      context.fillText(String(views), plot.left - 8, y);
    }
    context.textBaseline = 'top';
    for (let tick = 0; tick <= X_TICKS; tick += 1) {
      const time = scale.fromMs + (tick / X_TICKS) * (scale.toMs - scale.fromMs);
      context.textAlign = X_TICK_ALIGN[tick] ?? 'center';
      context.fillText(tickLabel(time, series.unit), scale.x(time), plot.top + plot.height + 10);
    }
  }

  function drawViews(context, plot, scale, series) {
    context.save();
    context.beginPath();
    context.rect(plot.left, plot.top, plot.width, plot.height);
    context.clip();
    context.beginPath();
    series.points.forEach((point, index) => {
      const x = scale.x(Date.parse(point.time));
      if (index === 0) context.moveTo(x, scale.y(point.views));
      else context.lineTo(x, scale.y(point.views));
    });
    context.strokeStyle = COLORS.line;
    context.lineWidth = 2;
    context.stroke();
    context.lineTo(scale.x(Date.parse(series.points.at(-1).time)), scale.y(0));
    context.lineTo(scale.x(Date.parse(series.points[0].time)), scale.y(0));
    context.closePath();
    context.fillStyle = COLORS.fill;
    context.fill();
    context.restore();
  }

  // Marker numbers match the rows of the versions table.
  function drawMarkers(context, plot, scale, series) {
    context.font = 'bold 11px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    series.publications.forEach((publication, index) => {
      const time = Date.parse(publication.publishedAt);
      if (time < scale.fromMs || time > scale.toMs) return;
      const x = scale.x(time);
      const color = COLORS[publication.kind];
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(x, plot.top);
      context.lineTo(x, plot.top + plot.height);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, plot.top - 12, 9, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = '#fff';
      context.fillText(String(index + 1), x, plot.top - 12);
    });
  }

  function drawChart(series) {
    const { context, width, height } = prepareCanvas();
    const plot = { left: MARGIN.left, top: MARGIN.top, width: width - MARGIN.left - MARGIN.right, height: height - MARGIN.top - MARGIN.bottom };
    const peak = Math.max(1, ...series.points.map(point => point.views));
    const yStep = niceStep(peak / Y_TICKS);
    const fromMs = Date.parse(series.from);
    const toMs = Date.parse(series.to);
    const scale = {
      fromMs, toMs, yStep,
      x: time => plot.left + ((time - fromMs) / (toMs - fromMs)) * plot.width,
      y: views => plot.top + plot.height - (views / (yStep * Y_TICKS)) * plot.height
    };
    drawAxes(context, plot, scale, series);
    drawViews(context, plot, scale, series);
    drawMarkers(context, plot, scale, series);
  }

  function tableCell(row, text) {
    const cell = row.insertCell();
    cell.textContent = text;
  }

  // Compares versions by views per hour, counting only the part of each version's live period inside the range.
  function renderVersions(series) {
    const fromMs = Date.parse(series.from);
    const toMs = Date.parse(series.to);
    versionsBody.replaceChildren();
    series.publications.forEach((publication, index) => {
      const next = series.publications[index + 1];
      const liveStart = Math.max(Date.parse(publication.publishedAt), fromMs);
      const liveEnd = Math.min(next ? Date.parse(next.publishedAt) : toMs, toMs);
      const liveHours = (liveEnd - liveStart) / HOUR_MS;
      const row = versionsBody.insertRow();
      tableCell(row, String(index + 1));
      tableCell(row, KIND_LABELS[publication.kind]);
      tableCell(row, formatPublished(publication.publishedAt));
      tableCell(row, publication.views.toLocaleString('en-US'));
      tableCell(row, liveHours > 0 ? (publication.views / liveHours).toFixed(1) : '\u2014');
    });
  }

  function showSeries(series) {
    currentSeries = series;
    const total = series.publications.reduce((sum, publication) => sum + publication.views, 0);
    chartTitle.textContent = series.article.title || 'Untitled article';
    canvas.setAttribute('aria-label', `Views per ${series.unit} for ${chartTitle.textContent}: ${total} views in the selected range.`);
    const dayNote = series.unit === 'day' ? ' Days are UTC.' : '';
    chartStatus.textContent = total ? `${total.toLocaleString('en-US')} views, shown per ${series.unit}.${dayNote}` : 'No views were recorded in this period.';
    drawChart(series);
    renderVersions(series);
  }

  async function loadSeries() {
    const request = ++seriesRequest;
    const to = new Date();
    const from = new Date(to.getTime() - Number(range.value) * HOUR_MS);
    panel.hidden = false;
    chartStatus.textContent = 'Loading views\u2026';
    try {
      const query = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
      const series = await getJson(`/analytics/articles/${encodeURIComponent(selectedId)}/views?${query}`);
      if (request === seriesRequest) showSeries(series);
    } catch (error) {
      if (request === seriesRequest) chartStatus.textContent = error.message;
    }
  }

  function selectArticle(id) {
    selectedId = id;
    history.replaceState(null, '', `/analytics?article=${encodeURIComponent(id)}`);
    results.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-current', String(button.dataset.id === id));
    });
    loadSeries();
  }

  function renderResults(articles) {
    results.replaceChildren(...articles.map(article => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result-button';
      button.dataset.id = article.id;
      button.setAttribute('aria-current', String(article.id === selectedId));
      button.textContent = `${article.title || 'Untitled article'} \u00b7 ${formatPublished(article.publishedAt)}`;
      item.append(button);
      return item;
    }));
  }

  async function search() {
    const request = ++searchRequest;
    searchStatus.textContent = 'Searching\u2026';
    try {
      const articles = await getJson(`/analytics/articles?q=${encodeURIComponent(searchInput.value)}`);
      if (request !== searchRequest) return;
      renderResults(articles);
      searchStatus.textContent = articles.length ? '' : 'No published articles match.';
    } catch (error) {
      if (request === searchRequest) searchStatus.textContent = error.message;
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, SEARCH_DELAY_MS);
  });
  results.addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (button) selectArticle(button.dataset.id);
  });
  range.addEventListener('change', loadSeries);
  new ResizeObserver(() => { if (currentSeries) drawChart(currentSeries); }).observe(canvas);

  search();
  if (selectedId) loadSeries();
})();
