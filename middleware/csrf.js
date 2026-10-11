// A single configured browser origin; never trust Host or forwarded headers.
function applicationOrigin() {
  const value = process.env.APP_ORIGIN || (process.env.NODE_ENV !== 'production' ? `http://localhost:${process.env.PORT || 3000}` : '');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash ||
        (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
    return url.origin;
  } catch {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment; production requires HTTPS.');
  }
}

function sourceOrigin(value, isReferer) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value) || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (!isReferer && value !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const hasOrigin = req.headers.origin !== undefined;
  const source = sourceOrigin(hasOrigin ? req.headers.origin : req.headers.referer, !hasOrigin);
  if (!source || source !== applicationOrigin()) {
    return res.status(403).json({ error: 'CSRF_REJECTED', message: 'Request origin could not be verified. Reload the site at its configured address and try again.' });
  }
  next();
}

module.exports = { applicationOrigin, csrfProtection };
