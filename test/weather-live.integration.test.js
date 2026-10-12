const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherService } = require('../services/weather');

test('configured location against real Open-Meteo: timestamps, cache, concurrent refresh and recovery', {
  skip: process.env.WEATHER_LIVE_TEST !== '1' && 'Set WEATHER_LIVE_TEST=1 to contact the real provider.', timeout: 30000
}, async t => {
  let calls = 0;
  let fail = true;
  // Place the controlled outage in the past so recovery uses the real wall clock.
  let offset = -60000;
  const service = createWeatherService({ now: () => Date.now() + offset,
    fetchProvider: async (...args) => {
      calls++;
      if (fail) throw new Error('Controlled outage before real-provider recovery');
      return fetch(...args);
    }, logger: { warn() {} } });
  assert.equal((await service.getWeather()).status, 'unavailable');
  assert.equal(calls, 1);
  await Promise.all(Array.from({ length: 50 }, () => service.getWeather()));
  assert.equal(calls, 1, 'Backoff prevents repeated calls.');
  offset = 0;
  fail = false;
  const results = await Promise.all(Array.from({ length: 50 }, () => service.getWeather()));
  assert.equal(calls, 2, 'Fifty callers share one real-provider refresh.');
  const data = results[0];
  assert.equal(data.status, 'available', 'Real provider must return fresh configured-location conditions.');
  assert.ok(results.every(result => result === data));
  assert.equal(data.location, process.env.WEATHER_LOCATION.trim());
  assert.ok(Date.parse(data.dataTime) <= Date.parse(data.fetchedAt));
  assert.ok(Date.parse(data.expiresAt) - Date.parse(data.dataTime) <= 900000);
  assert.ok(Date.now() + offset < Date.parse(data.expiresAt));
  assert.deepEqual(await service.getWeather(), data);
  assert.equal(calls, 2, 'Warm cache makes no provider request.');
  t.diagnostic(JSON.stringify({ ...data, providerCalls: calls, concurrentRequests: 50, recoveryClockOffsetMs: offset }));
});
