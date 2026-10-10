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
    try {
      const { location, url } = configuration();
      // The deadline covers both the response headers and the JSON body.
      const timeout = new Promise((_, reject) => {
        timer = schedule(() => {
          controller.abort();
          reject(new Error('Weather timeout'));
        }, 5000);
      });
      const payload = await Promise.race([timeout, (async () => {
        const response = await fetchProvider(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Weather provider failure');
        return response.json();
      })()]);
      const fetchedAt = now();
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
      logger.warn('Weather refresh failed; retry delayed for one minute.');
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
