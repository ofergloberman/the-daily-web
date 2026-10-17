const { createHash } = require('node:crypto');
const Session = require('../models/Session');
const { ROLES } = require('../config/constants');
const { sendError, wantsHtmlPage } = require('../helpers/sendError');

const COOKIE_NAME = 'wd_session';
const LOGIN_PATH = '/auth';

function readSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const pair = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  const token = pair?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function loadUser(req, res, next) {
  try {
    const token = readSessionToken(req.headers.cookie);
    if (!token) return next();
    const session = await Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).populate('user');
    if (session?.user && [ROLES.REPORTER, ROLES.EDITOR].includes(session.user.role)) {
      req.user = session.user;
      req.session = session;
    } else {
      res.clearCookie(COOKIE_NAME, { path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    }
    next();
  } catch (error) { next(error); }
}

function sendAuthRequired(req, res) {
  return sendError(req, res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
}

function requireAuth(req, res, next) {
  if (!req.user) return sendAuthRequired(req, res);
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return wantsHtmlPage(req) ? res.redirect(303, LOGIN_PATH) : sendAuthRequired(req, res);
    if (req.user.role !== role) return sendError(req, res, 403, 'FORBIDDEN', 'Your account cannot open this area.');
    next();
  };
}

const requireReporter = requireRole(ROLES.REPORTER);
const requireEditor = requireRole(ROLES.EDITOR);

module.exports = { COOKIE_NAME, readSessionToken, hashToken, loadUser, requireAuth, requireReporter, requireEditor };
