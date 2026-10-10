const weather = require('../services/weather');

async function getWeather(_req, res) {
  const result = await weather.getWeather();
  res.set('Cache-Control', 'no-store');
  // Lets browsers calculate remaining freshness independently of their clock setting.
  res.set('X-Weather-Server-Time', new Date().toISOString());
  res.json(result);
}

module.exports = { getWeather };
