const { logEvent } = require('../helpers/logging');
const MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const BACKOFF_MS = 60 * 1000;
const WEATHER_CODES = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
const UNAVAILABLE = Object.freeze({ status: 'unavailable', message: 'Weather is temporarily unavailable.' });

// One instance is shared by all requests in this single-process server.
// Dependencies are injectable so tests need neither the network nor real waits.
function createWeatherService({ env = process.env, fetchProvider = (...args) => fetch(...args), now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, logger = console } = {}) {
  let cached = null;
  let inFlight = null;
  let retryAt = 0;

  function configuration() {
    const location = env.WEATHER_LOCATION?.trim();
    const latitude = Number(env.WEATHER_LATITUDE);
    const longitude = Number(env.WEATHER_LONGITUDE);
    if (!location || location.length > 100 || !env.WEATHER_LATITUDE?.trim() || !env.WEATHER_LONGITUDE?.trim()
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Invalid weather configuration');
    }
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude, longitude, current: 'temperature_2m,weather_code',
      temperature_unit: 'celsius', timezone: 'GMT', timeformat: 'unixtime' });
    return { location, url };
  }

  function usable() {
    const time = now();
    return cached && time >= Date.parse(cached.dataTime) && time >= Date.parse(cached.fetchedAt)
      && time < Date.parse(cached.expiresAt);
  }

  async function refresh() {
    const controller = new AbortController();
    let timer;
    let reason = 'CONFIGURATION';
    try {
      const { location, url } = configuration();
      reason = 'PROVIDER_NETWORK';
      // The deadline covers both the response headers and the JSON body.
      const timeout = new Promise((_, reject) => {
        timer = schedule(() => {
          reason = 'TIMEOUT';
          controller.abort();
          reject(new Error('Weather timeout'));
        }, 5000);
      });
      const payload = await Promise.race([timeout, (async () => {
        const response = await fetchProvider(url, { signal: controller.signal });
        if (!response.ok) {
          if (reason !== 'TIMEOUT') reason = 'PROVIDER_HTTP';
          throw new Error('Weather provider failure');
        }
        // Do not let late completion overwrite the timeout classification.
        try { return await response.json(); }
        catch (error) { if (reason !== 'TIMEOUT') reason = 'PROVIDER_JSON'; throw error; }
      })()]);
      const fetchedAt = now();
      reason = 'INVALID_OR_STALE_DATA';
      const current = payload?.current;
      const dataTime = current?.time * 1000;
      if (!Number.isSafeInteger(current?.time) || !Number.isFinite(dataTime)
        || dataTime > fetchedAt || fetchedAt - dataTime >= MAX_AGE_MS
        || !Number.isFinite(current?.temperature_2m) || !WEATHER_CODES.has(current?.weather_code)
        || payload?.current_units?.temperature_2m !== '°C'
        || payload?.current_units?.time !== 'unixtime') {
        throw new Error('Invalid or stale weather data');
      }
      cached = Object.freeze({ status: 'available', location, temperatureC: current.temperature_2m,
        weatherCode: current.weather_code, dataTime: new Date(dataTime).toISOString(),
        fetchedAt: new Date(fetchedAt).toISOString(),
        expiresAt: new Date(Math.min(dataTime, fetchedAt) + MAX_AGE_MS).toISOString() });
      retryAt = 0;
    } catch {
      retryAt = now() + BACKOFF_MS;
      logEvent('warn', 'weather.refresh', { outcome: 'failure', reason, scope: 'weather' }, logger);
    } finally {
      cancel(timer);
    }
  }

  async function getWeather() {
    if (usable() && now() - Date.parse(cached.fetchedAt) < REFRESH_MS) return cached;
    if (now() >= retryAt) {
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      await inFlight;
    }
    return usable() ? cached : UNAVAILABLE;
  }

  return { getWeather };
}

module.exports = { createWeatherService, ...createWeatherService() };
