// Render the actual D3 templates and assets with an empty feed, without database writes.
// This preview is loopback-only and is never part of the production server.
const express = require('express');
const path = require('node:path');
const { formatDate } = require('../helpers/dates');
const { createWeatherService } = require('../services/weather');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.locals.formatDate = formatDate;
app.use(express.static(path.join(__dirname, '../public')));
app.use('/verification', express.static(path.join(__dirname, '../docs/verification')));
// Source links in the local report expose only code and the named public documentation.
app.get(/^\/(?:test|scripts|controllers|middleware|models|services|routes|views)\/[\w./-]+\.(?:js|css|ejs)$/, (req, res) => {
  if (req.path.split('/').includes('..')) return res.sendStatus(400);
  res.type('text/plain').sendFile(path.join(__dirname, '..', req.path));
});
for (const name of ['README.md', '.env.example', 'docs/PROJECT_REQUIREMENTS.md', 'docs/USER_MAINTENANCE.md']) {
  app.get(`/${name}`, (_req, res) => res.type('text/plain').sendFile(path.join(__dirname, '..', name)));
}
let mode = 'live';
let expiryStart = 0;
const service = createWeatherService();
app.get('/weather', async (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Weather-Server-Time': new Date().toISOString() });
  if (mode === 'unavailable') return res.json({ status: 'unavailable', message: 'Weather is temporarily unavailable.' });
  if (mode === 'expiry') {
    const now = expiryStart;
    return res.json({ status: 'available', location: 'Expiry check', temperatureC: 24, weatherCode: 0,
      dataTime: new Date(now - 895000).toISOString(), fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5000).toISOString() });
  }
  res.json(await service.getWeather());
});
app.get('/preview-mode/:mode', (req, res) => {
  if (!['live', 'unavailable', 'expiry'].includes(req.params.mode)) return res.sendStatus(400);
  mode = req.params.mode;
  if (mode === 'expiry') expiryStart = Date.now();
  res.send(`Preview mode: ${mode}. <a href="/">Open homepage</a>`);
});
app.get('/', (_req, res) => res.render('index', { user: null, articles: [], categories: [],
  filters: { q: '', category: '', sort: 'date' }, sorts: ['date', 'popular'], nextCursor: null, hasMore: false }));
app.get('/acceptance', (_req, res) => res.sendFile(path.join(__dirname, '../docs/verification/report.html')));
const server = app.listen(3407, '127.0.0.1', () => console.log('Acceptance preview: http://127.0.0.1:3407'));
process.once('SIGTERM', () => server.close());
