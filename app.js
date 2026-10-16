const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { connectDatabase } = require('./config/database');
const { loadUser, requireReporter, requireEditor } = require('./middleware/auth');
const { deviceIdentity } = require('./middleware/deviceIdentity');
const { showHome } = require('./controllers/publicArticleController');
const { formatDate } = require('./helpers/dates');
const { applicationOrigin, csrfProtection } = require('./middleware/csrf');
const { sendError } = require('./helpers/sendError');

// Logs only what is needed to trace a failure: never the body, cookies, query string or the error object.
function logRequestFailure(req, status, error) {
  console.error('Request failed:', req.method, req.path, status, error.name);
}

function handleError(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return sendError(req, res, 400, 'INVALID_JSON', 'The request body is not valid JSON.');
  if (error.type === 'entity.too.large') return sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  // Express marks an address it cannot decode (for example a broken %zz) with status 400.
  if (error.status === 400) return sendError(req, res, 400, 'BAD_REQUEST', 'The request could not be understood.');
  if (mongoose.connection.readyState !== mongoose.STATES.connected) {
    logRequestFailure(req, 503, error);
    return sendError(req, res, 503, 'DATABASE_UNAVAILABLE', 'The service is temporarily unavailable. Try again in a moment.');
  }
  logRequestFailure(req, 500, error);
  sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Something went wrong. Try again.');
}

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
app.use((req, res) => sendError(req, res, 404, 'NOT_FOUND', 'This page does not exist or is no longer available.'));
app.use(handleError);

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
