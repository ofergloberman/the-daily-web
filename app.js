const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { connectDatabase } = require('./config/database');
const { loadUser, requireReporter, requireEditor } = require('./middleware/auth');
const { deviceIdentity } = require('./middleware/deviceIdentity');
const { editorArea } = require('./controllers/authController');
const { showHome } = require('./controllers/publicArticleController');
const { formatDate } = require('./helpers/dates');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.formatDate = formatDate;
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected' });
});
app.use(deviceIdentity);
app.use(loadUser);
app.get('/', showHome);
app.use('/auth', require('./routes/auth'));
app.use('/reporter', requireReporter, require('./routes/reporter'));
app.get('/editor', requireEditor, editorArea);
app.use('/articles', require('./routes/articles'));
app.use('/comments', require('./routes/comments'));
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  console.error('Request failed:', error.name);
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  await connectDatabase(process.env.MONGODB_URI);
  const server = app.listen(port, () => console.log(`The Daily Web: http://localhost:${port}`));
  server.on('error', async (error) => {
    console.error('HTTP server failed:', error.code);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
  function shutdown() {
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => { await mongoose.disconnect(); clearTimeout(timeout); });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start().catch(async () => {
    console.error('Startup failed. Check PORT, MONGODB_URI and MongoDB availability.');
    await mongoose.disconnect();
    process.exitCode = 1;
  });
}

module.exports = { app, start };
