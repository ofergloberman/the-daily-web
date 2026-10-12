// Origin is supplied by browsers, never inferred from Host or proxy headers.
function applicationOrigin() {
  const configured = process.env.APP_ORIGIN;
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('APP_ORIGIN is required in production.');
  const value = configured || `http://localhost:${process.env.PORT || 3000}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGIN must be one HTTP(S) origin without credentials, path, query or fragment.');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production.');
  return url.origin;
}

function requestOrigin(headers) {
  // A present but invalid Origin must never fall back to Referer.
  if (headers.origin !== undefined) {
    if (typeof headers.origin !== 'string') return null;
    try {
      const url = new URL(headers.origin);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === headers.origin ? url.origin : null;
    } catch { return null; }
  }
  if (typeof headers.referer !== 'string') return null;
  try {
    const url = new URL(headers.referer);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let expected;
  try { expected = applicationOrigin(); }
  catch {
    console.error('CSRF configuration invalid.');
    return res.status(503).json({ error: 'CSRF_UNAVAILABLE', message: 'Request protection is not configured.' });
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' || requestOrigin(req.headers) !== expected) {
    console.warn('CSRF request rejected:', req.method);
    return res.status(403).json({ error: 'CSRF_REJECTED', message: 'Open this site directly and retry your request.' });
  }
  return next();
}

module.exports = { applicationOrigin, requestOrigin, csrfProtection };
