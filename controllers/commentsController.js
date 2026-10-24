const mongoose = require('mongoose');
const comments = require('../services/comments');
const { COMMENT_BODY_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } = require('../config/constants');

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const CURSOR_MAX_LENGTH = 200;

function validId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) && mongoose.isValidObjectId(value);
}

function trimmed(value, max) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result.length >= 1 && result.length <= max ? result : null;
}

function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!validId(parsed.id) || typeof parsed.at !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.at) ||
        !Number.isFinite(Date.parse(parsed.at))) return false;
    return { id: parsed.id, at: new Date(parsed.at) };
  } catch { return false; }
}

function cursorFor(comment) {
  return Buffer.from(JSON.stringify({ at: comment.createdAt.toISOString(), id: String(comment._id) })).toString('base64url');
}

async function list(req, res, next) {
  const { articleId } = req.query;
  const limit = req.query.limit === undefined ? PAGE_SIZE : Number(req.query.limit);
  const cursor = parseCursor(req.query.cursor);
  if (!validId(articleId) || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE || cursor === false) {
    return res.status(400).json({ error: 'INVALID_COMMENT_QUERY' });
  }
  try {
    if (!await comments.publishedArticleExists(articleId)) return res.status(404).json({ error: 'ARTICLE_NOT_FOUND' });
    const { rows, hasMore } = await comments.listForArticle(articleId, { cursor, limit });
    res.json({ comments: rows.map(comments.publicComment), nextCursor: hasMore ? cursorFor(rows.at(-1)) : null });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  const { articleId } = req.body || {};
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !['articleId', 'displayName', 'body'].includes(key))) {
    return res.status(400).json({ error: 'INVALID_COMMENT' });
  }
  const body = trimmed(req.body?.body, COMMENT_BODY_MAX_LENGTH);
  const displayName = req.user ? trimmed(req.user.displayName, DISPLAY_NAME_MAX_LENGTH) : trimmed(req.body?.displayName, DISPLAY_NAME_MAX_LENGTH);
  if (!validId(articleId) || !body || !displayName) return res.status(400).json({ error: 'INVALID_COMMENT' });
  // A guest without a device cookie gets a fresh id on every request, which would bypass the per-device limit.
  if (!req.user && req.deviceIsNew) {
    return res.status(400).json({ error: 'DEVICE_REQUIRED', message: 'Please reload the page and try again.' });
  }
  try {
    const outcome = req.user
      ? await comments.createAuthenticatedComment({ articleId, body, user: req.user })
      : await comments.createGuestComment({ articleId, displayName, body, deviceId: req.deviceId });
    if (outcome.kind === 'notFound') return res.status(404).json({ error: 'ARTICLE_NOT_FOUND' });
    if (outcome.kind === 'limited') {
      res.set('Retry-After', String(outcome.retryAfterSeconds));
      return res.status(429).json({
        error: 'COMMENT_RATE_LIMIT',
        message: 'You can post three comments per minute. Please try again shortly.',
        retryAfterSeconds: outcome.retryAfterSeconds
      });
    }
    console.info('Comment created:', outcome.comment.id);
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, `/articles/${articleId}#comments`);
    res.status(201).json({ comment: outcome.comment });
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ error: 'INVALID_COMMENT' });
    next(error);
  }
}

async function read(req, res, next) {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'INVALID_COMMENT_ID' });
  try {
    const comment = await comments.findById(req.params.id);
    if (!comment || !await comments.publishedArticleExists(comment.article)) return res.status(404).json({ error: 'COMMENT_NOT_FOUND' });
    res.json({ comment: comments.publicComment(comment) });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'INVALID_COMMENT_ID' });
  const body = trimmed(req.body?.body, COMMENT_BODY_MAX_LENGTH);
  if (!body || Object.keys(req.body).some(key => key !== 'body')) return res.status(400).json({ error: 'INVALID_COMMENT' });
  try {
    const comment = await comments.updateBody(req.params.id, body);
    if (!comment) return res.status(404).json({ error: 'COMMENT_NOT_FOUND' });
    res.json({ comment: comments.publicComment(comment) });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'INVALID_COMMENT_ID' });
  try {
    const deleted = await comments.deleteById(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'COMMENT_NOT_FOUND' });
    res.status(204).end();
  } catch (error) { next(error); }
}

module.exports = { list, create, read, update, remove };
