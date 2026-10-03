const { randomBytes } = require('node:crypto');
const User = require('../models/User');
const Session = require('../models/Session');
const { ROLES } = require('../config/constants');
const { COOKIE_NAME, hashToken, readSessionToken } = require('../middleware/auth');

const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

function destination(user) {
  return user.role === ROLES.EDITOR ? '/editor' : '/reporter';
}

function showLogin(req, res) {
  if (req.user) return res.redirect(destination(req.user));
  res.render('login', { error: null });
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    const form = req.is('application/x-www-form-urlencoded');
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || username.length > 50 || !password) {
      if (form) return res.status(400).render('login', { error: 'Enter a username and password.' });
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const user = await User.findOne({ username: username.trim().toLowerCase() }).select('+passwordHash');
    if (!user || ![ROLES.REPORTER, ROLES.EDITOR].includes(user.role) || !(await user.verifyPassword(password))) {
      if (form) return res.status(401).render('login', { error: 'Invalid username or password.' });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    const oldToken = readSessionToken(req.headers.cookie);
    if (oldToken) await Session.deleteOne({ tokenHash: hashToken(oldToken) });
    const token = randomBytes(32).toString('hex');
    await Session.create({ tokenHash: hashToken(token), user: user._id, expiresAt: new Date(Date.now() + SESSION_AGE_MS) });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', maxAge: SESSION_AGE_MS
    });
    console.info('User logged in:', user.id);
    if (form) return res.redirect(303, destination(user));
    return res.json({ user: publicUser(user), redirectTo: destination(user) });
  } catch (error) { next(error); }
}

async function logout(req, res, next) {
  try {
    const token = readSessionToken(req.headers.cookie);
    if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
    res.clearCookie(COOKIE_NAME, { path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, '/auth');
    return res.status(204).end();
  } catch (error) { next(error); }
}

function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

function editorArea(req, res) {
  res.render('workArea', { user: publicUser(req.user), title: 'Editor management area' });
}

module.exports = { showLogin, login, logout, me, editorArea };
