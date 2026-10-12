// Only explicitly allowed metadata reaches operational logs. Never pass request
// bodies, headers, documents or raw exceptions to the console.
const events = new Set(['auth.login', 'auth.logout', 'auth.rejected', 'account.create',
  'account.read', 'account.list', 'account.update', 'account.reset-password', 'account.delete',
  'comment.create', 'comment.update', 'comment.delete', 'comment.rejected',
  'weather.refresh', 'request.failed', 'request.rejected', 'csrf.rejected', 'csrf.unavailable']);
const reasons = new Set(['INVALID_INPUT', 'INVALID_CREDENTIALS', 'AUTH_REQUIRED', 'FORBIDDEN',
  'INVALID_COMMENT', 'INVALID_COMMENT_ID', 'INVALID_COMMENT_QUERY', 'ARTICLE_NOT_FOUND',
  'COMMENT_NOT_FOUND', 'COMMENT_RATE_LIMIT', 'INVALID_JSON', 'PAYLOAD_TOO_LARGE',
  'INTERNAL_SERVER_ERROR', 'DUPLICATE_USERNAME', 'USER_NOT_FOUND', 'USER_REFERENCED',
  'DATABASE_FAILURE', 'CSRF_REJECTED', 'CSRF_UNAVAILABLE', 'CONFIGURATION', 'TIMEOUT',
  'PROVIDER_HTTP', 'PROVIDER_NETWORK', 'PROVIDER_JSON', 'INVALID_OR_STALE_DATA']);
const endpoints = new Set(['/auth/login', '/auth/logout', '/auth/me', '/auth',
  '/comments', '/comments/:id', '/weather', '/reporter', '/editor', '/analytics', '/articles']);
const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'ValidationError', 'CastError',
  'MongooseError', 'MongoServerError', 'MongoNetworkError', 'MongoServerSelectionError']);

function logEvent(level, event, details = {}, logger = console) {
  if (!['info', 'warn', 'error'].includes(level) || !events.has(event)) return;
  const entry = { timestamp: new Date().toISOString(), level, event };
  if (['success', 'rejected', 'failure'].includes(details.outcome)) entry.outcome = details.outcome;
  if (reasons.has(details.reason)) entry.reason = details.reason;
  if (['auth', 'comments', 'weather', 'maintenance', 'request'].includes(details.scope)) entry.scope = details.scope;
  if (endpoints.has(details.endpoint)) entry.endpoint = details.endpoint;
  if (errorTypes.has(details.errorType)) entry.errorType = details.errorType;
  if (['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(details.method)) entry.method = details.method;
  if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) entry.status = details.status;
  for (const field of ['actorId', 'userId', 'commentId', 'articleId']) {
    if (typeof details[field] === 'string' && /^[a-f\d]{24}$/i.test(details[field])) entry[field] = details[field];
  }
  logger[level](JSON.stringify(entry));
}

function requestContext(req) {
  // Router middleware sees a relative req.path; baseUrl restores the mount path.
  const path = (req.baseUrl || '') + (req.path || '');
  const scope = ['auth', 'comments', 'weather'].find(value =>
    path === `/${value}` || path.startsWith(`/${value}/`)) || 'request';
  const endpoint = path.startsWith('/comments/') ? '/comments/:id' : path;
  return { scope, endpoint, method: req.method, actorId: req.user?.id };
}

module.exports = { logEvent, requestContext };
