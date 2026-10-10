(() => {
  const slot = document.getElementById('weather-slot');
  if (!slot) return;
  const field = name => slot.querySelector(`[data-weather-${name}]`);
  const details = field('details');
  const message = field('message');
  let expiryTimer;
  let refreshTimer;
  let deadline = 0;
  let wallDeadline = 0;
  let pending = false;

  function unavailable() {
    details.hidden = true;
    message.hidden = false;
    message.textContent = 'Weather is temporarily unavailable.';
    deadline = 0;
    clearTimeout(expiryTimer);
  }

  function expire() {
    if (deadline && (performance.now() >= deadline || Date.now() >= wallDeadline)) unavailable();
  }

  function condition(code) {
    if (code === 0) return 'Clear sky';
    if (code <= 3) return ['Mainly clear', 'Partly cloudy', 'Overcast'][code - 1];
    if (code <= 48) return 'Fog';
    if (code <= 57) return 'Drizzle';
    if (code <= 67) return 'Rain';
    if (code <= 77) return 'Snow';
    if (code <= 82) return 'Rain showers';
    if (code <= 86) return 'Snow showers';
    return 'Thunderstorm';
  }

  async function refresh() {
    expire();
    if (pending || document.hidden) return;
    pending = true;
    clearTimeout(refreshTimer);
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let nextRefresh = 60000;
    try {
      const response = await fetch('/weather', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Weather unavailable');
      const data = await response.json();
      const serverTime = Date.parse(response.headers.get('X-Weather-Server-Time'));
      const dataTime = Date.parse(data.dataTime);
      const fetchedAt = Date.parse(data.fetchedAt);
      const expiresAt = Math.min(Date.parse(data.expiresAt), dataTime + 900000, fetchedAt + 900000);
      // Subtract the whole request duration conservatively, including body transfer.
      const remaining = expiresAt - serverTime - (performance.now() - started);
      if (data.status !== 'available' || !Number.isFinite(remaining) || remaining <= 0
        || dataTime > serverTime || fetchedAt > serverTime || !Number.isFinite(data.temperatureC)
        || !Number.isInteger(data.weatherCode) || typeof data.location !== 'string') {
        throw new Error('Weather unavailable');
      }
      if (document.hidden) return;
      field('location').textContent = data.location;
      field('temperature').textContent = `${Math.round(data.temperatureC)} °C`;
      field('condition').textContent = condition(data.weatherCode);
      field('time').dateTime = data.dataTime;
      field('time').textContent = new Date(dataTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      deadline = performance.now() + remaining;
      wallDeadline = Date.now() + remaining;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(unavailable, remaining);
      details.hidden = false;
      message.hidden = true;
      nextRefresh = Math.max(1000, Math.min(300000, remaining));
    } catch {
      unavailable();
    } finally {
      clearTimeout(timeout);
      pending = false;
      refreshTimer = setTimeout(refresh, nextRefresh);
    }
  }

  document.addEventListener('visibilitychange', () => {
    // Clear before a suspended tab becomes visible; request a fresh result on return.
    unavailable();
    if (!document.hidden) refresh();
  });
  window.addEventListener('pagehide', unavailable);
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', () => { expire(); if (!deadline) refresh(); });
  refresh();
})();
