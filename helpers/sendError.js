const STATUS_TITLES = Object.freeze({
  400: 'Invalid request',
  401: 'Sign in required',
  403: 'Access denied',
  404: 'Page not found',
  413: 'Request too large',
  500: 'Server error',
  503: 'Service unavailable'
});
const DEFAULT_TITLE = 'Something went wrong';
const HOME_LINK = Object.freeze({ href: '/', text: 'Back to the latest news' });

// A browser opening a page prefers HTML; fetch sends Accept: */* or application/json and gets JSON.
function wantsHtmlPage(req) {
  return req.method === 'GET' && req.accepts(['json', 'html']) === 'html';
}

// One answer for every failure: an error page for a browser page request, { error, message } for everything else.
function sendError(req, res, status, code, message, link = HOME_LINK) {
  if (wantsHtmlPage(req)) {
    return res.status(status).render('error', {
      user: req.user, title: STATUS_TITLES[status] ?? DEFAULT_TITLE, message, linkHref: link.href, linkText: link.text
    });
  }
  return res.status(status).json({ error: code, message });
}

module.exports = { sendError, wantsHtmlPage };
