const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherService } = require('../services/weather');

const MINUTE = 60000;
const START = Date.parse('2026-10-10T12:00:00Z');
const env = { WEATHER_LOCATION: 'Tel Aviv', WEATHER_LATITUDE: '32.0853', WEATHER_LONGITUDE: '34.7818' };
const unavailable = { status: 'unavailable', message: 'Weather is temporarily unavailable.' };
function payload(time = START) {
  return { current: { time: time / 1000, temperature_2m: 24, weather_code: 0 },
    current_units: { time: 'unixtime', temperature_2m: '°C' } };
}
function setup(provider = async () => ({ ok: true, json: async () => payload() }), config = env) {
  let time = START;
  const calls = [];
  const timers = new Map();
  const warnings = [];
  const service = createWeatherService({ env: config, now: () => time,
    fetchProvider: (...args) => { calls.push(args); return provider(...args); },
    schedule: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id), logger: { warn: text => warnings.push(text) } });
  return { ...service, calls, timers, warnings, setTime: value => { time = value; } };
}

test('weather returns the response contract and reuses cache until five minutes', async () => {
  const service = setup();
  const result = await service.getWeather();
  assert.deepEqual(result, { status: 'available', location: 'Tel Aviv', temperatureC: 24, weatherCode: 0,
    dataTime: new Date(START).toISOString(), fetchedAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 15 * MINUTE).toISOString() });
  const url = service.calls[0][0];
  assert.equal(url.origin, 'https://api.open-meteo.com');
  assert.equal(url.searchParams.get('latitude'), env.WEATHER_LATITUDE);
  assert.equal(url.searchParams.get('current'), 'temperature_2m,weather_code');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  service.setTime(START + 5 * MINUTE - 1);
  assert.deepEqual(await service.getWeather(), result);
  assert.equal(service.calls.length, 1);
  service.setTime(START + 5 * MINUTE);
  await service.getWeather();
  assert.equal(service.calls.length, 2);
  assert.equal(service.timers.size, 0);
});

test('cold and expired-cache concurrent visitors share one refresh', async () => {
  let release;
  const service = setup(() => new Promise(resolve => { release = resolve; }));
  for (const time of [START, START + 5 * MINUTE]) {
    service.setTime(time);
    const before = service.calls.length;
    const requests = Array.from({ length: 100 }, () => service.getWeather());
    assert.equal(service.calls.length, before + 1);
    release({ ok: true, json: async () => payload(time) });
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.status === 'available'));
    assert.equal(service.calls.length, before + 1);
  }
});

test('five-second timeout covers headers and body, aborts and backs off', async () => {
  for (const bodyStalls of [false, true]) {
    const never = new Promise(() => {});
    const service = setup(() => bodyStalls ? Promise.resolve({ ok: true, json: () => never }) : never);
    const pending = service.getWeather();
    await Promise.resolve();
    const timer = [...service.timers.values()][0];
    assert.equal(timer.delay, 5000);
    service.setTime(START + 5000);
    timer.callback();
    assert.deepEqual(await pending, unavailable);
    assert.equal(service.calls[0][1].signal.aborted, true);
    assert.deepEqual(await service.getWeather(), unavailable);
    assert.equal(service.calls.length, 1);
    assert.equal(service.timers.size, 0);
  }
});

test('late provider completion after a timeout cannot populate the cache', async () => {
  let release;
  const service = setup(() => new Promise(resolve => { release = resolve; }));
  const pending = service.getWeather();
  [...service.timers.values()][0].callback();
  await pending;
  release({ ok: true, json: async () => payload() });
  await Promise.resolve();
  assert.deepEqual(await service.getWeather(), unavailable);
});

test('provider HTTP, network and JSON failures back off and recover at the boundary', async () => {
  for (const fail of [() => ({ ok: false }), () => { throw new Error('network'); },
    () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })]) {
    let failed = true;
    const service = setup(async () => failed ? fail() : { ok: true, json: async () => payload() });
    assert.deepEqual(await service.getWeather(), unavailable);
    failed = false;
    service.setTime(START + MINUTE - 1);
    await Promise.all(Array.from({ length: 100 }, () => service.getWeather()));
    assert.equal(service.calls.length, 1);
    assert.equal(service.warnings.length, 1);
    service.setTime(START + MINUTE);
    assert.equal((await service.getWeather()).status, 'available');
    assert.equal(service.calls.length, 2);
  }
});

test('malformed, old and future provider data are rejected', async () => {
  const invalid = [null, {}, { current: null }, payload(START - 15 * MINUTE),
    payload(START - 16 * MINUTE), payload(START + 1000)];
  for (const [key, value] of [['time', '1791633600'], ['time', null], ['temperature_2m', null],
    ['temperature_2m', '24'], ['temperature_2m', Infinity], ['weather_code', 4], ['weather_code', '0']]) {
    const data = payload();
    data.current[key] = value;
    invalid.push(data);
  }
  const wrongUnits = payload();
  wrongUnits.current_units.temperature_2m = '°F';
  invalid.push(wrongUnits);
  for (const data of invalid) {
    const service = setup(async () => ({ ok: true, json: async () => data }));
    assert.deepEqual(await service.getWeather(), unavailable);
    await service.getWeather();
    assert.equal(service.calls.length, 1);
  }
});

test('fresh fallback expires by provider time during backoff, even before five minutes', async () => {
  let failed = false;
  const service = setup(async () => {
    if (failed) throw new Error('offline');
    return { ok: true, json: async () => payload(START - 14 * MINUTE) };
  });
  const first = await service.getWeather();
  assert.equal(first.expiresAt, new Date(START + MINUTE).toISOString());
  failed = true;
  service.setTime(START + MINUTE - 1);
  assert.equal((await service.getWeather()).status, 'available');
  service.setTime(START + MINUTE);
  assert.deepEqual(await service.getWeather(), unavailable);
  assert.equal(service.calls.length, 2);
  service.setTime(START + MINUTE + 1);
  assert.deepEqual(await service.getWeather(), unavailable);
  assert.equal(service.calls.length, 2);
});

test('failed refresh preserves only unexpired cache; fetch age and clock rollback are checked', async () => {
  let failed = false;
  const service = setup(async () => {
    if (failed) throw new Error('offline');
    return { ok: true, json: async () => payload() };
  });
  const initial = await service.getWeather();
  failed = true;
  service.setTime(START + 5 * MINUTE);
  assert.deepEqual(await service.getWeather(), initial);
  service.setTime(START + 15 * MINUTE);
  assert.deepEqual(await service.getWeather(), unavailable);
  service.setTime(START - 1000);
  assert.deepEqual(await service.getWeather(), unavailable);
});

test('missing or invalid location never contacts provider', async () => {
  for (const config of [{}, { ...env, WEATHER_LATITUDE: '' }, { ...env, WEATHER_LATITUDE: '91' },
    { ...env, WEATHER_LONGITUDE: '181' }, { ...env, WEATHER_LONGITUDE: 'abc' }, { ...env, WEATHER_LOCATION: ' ' }]) {
    const service = setup(undefined, config);
    assert.deepEqual(await service.getWeather(), unavailable);
    assert.equal(service.calls.length, 0);
  }
});

test('data that ages out while the provider body downloads is rejected', async () => {
  const service = setup(async () => ({ ok: true, json: async () => {
    service.setTime(START + 1000);
    return payload(START - 15 * MINUTE + 1000);
  } }));
  assert.deepEqual(await service.getWeather(), unavailable);
});

test('public endpoint returns both contracts, disables HTTP caching and bypasses session lookup', async t => {
  const weather = require('../services/weather');
  const Session = require('../models/Session');
  const { app } = require('../app');
  let result = unavailable;
  t.mock.method(weather, 'getWeather', async () => result);
  t.mock.method(Session, 'findOne', () => { assert.fail('Weather must not query sessions'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const value of [unavailable, await setup().getWeather()]) {
    result = value;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/weather?latitude=0`, {
      headers: { Cookie: `wd_session=${'a'.repeat(64)}` }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number.isFinite(Date.parse(response.headers.get('x-weather-server-time'))));
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), value);
  }
});
