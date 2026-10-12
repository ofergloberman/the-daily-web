const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { connectDatabase } = require('./config/database');
const { loadUser, requireReporter, requireEditor } = require('./middleware/auth');
const { deviceIdentity } = require('./middleware/deviceIdentity');
const { showHome } = require('./controllers/publicArticleController');
const { formatDate } = require('./helpers/dates');
const { applicationOrigin, csrfProtection } = require('./middleware/csrf');
const { logEvent, requestContext } = require('./helpers/logging');
const { errorBody } = require('./helpers/errors');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.formatDate = formatDate;
app.use(csrfProtection);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected' });
});
app.use('/weather', require('./routes/weather'));
app.use(deviceIdentity);
app.use(loadUser);
app.get('/', showHome);
app.use('/auth', require('./routes/auth'));
app.use('/reporter', requireReporter, require('./routes/reporter'));
app.use('/editor', requireEditor, require('./routes/editor'));
app.use('/analytics', requireEditor, require('./routes/analytics'));
app.use('/articles', require('./routes/articles'));
app.use('/comments', require('./routes/comments'));
app.use((_req, res) => res.status(404).json(errorBody('NOT_FOUND')));
app.use((error, req, res, _next) => {
  const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
  const code = status === 400 ? 'INVALID_JSON' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_SERVER_ERROR';
  logEvent(status === 500 ? 'error' : 'warn', status === 500 ? 'request.failed' : 'request.rejected',
    { ...requestContext(req), outcome: status === 500 ? 'failure' : 'rejected', status, reason: code, errorType: error.name });
  // A partial response cannot be replaced. Close it without handing the raw
  // exception to Express's default handler, which can print sensitive details.
  if (res.headersSent) return res.destroy();
  if (req.path === '/auth/login' && req.is('application/x-www-form-urlencoded')) {
    return res.status(status).render('login', { error: errorBody(code).message });
  }
  res.status(status).json(errorBody(code));
});

async function start() {
  applicationOrigin();
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
    console.error('Startup failed. Check PORT, MONGODB_URI, MongoDB availability and transaction support.');
    await mongoose.disconnect();
    process.exitCode = 1;
  });
}

module.exports = { app, start };
