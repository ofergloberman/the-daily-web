const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const comments = require('../services/comments');
const { logEvent } = require('../helpers/logging');
const { errorBody } = require('../helpers/errors');

function reject(req, res, status, reason) {
  logEvent('warn', 'comment.rejected', { outcome: 'rejected', reason, status,
    method: req.method, actorId: req.user?.id, commentId: req.params?.id });
  return res.status(status).json(errorBody(reason));
}

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

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
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
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
    return reject(req, res, 400, 'INVALID_COMMENT_QUERY');
  }
  try {
    if (!await comments.publishedArticleExists(articleId)) return reject(req, res, 404, 'ARTICLE_NOT_FOUND');
    const query = { article: articleId };
    if (cursor) query.$or = [
      { createdAt: { $lt: cursor.at } },
      { createdAt: cursor.at, _id: { $lt: cursor.id } }
    ];
    const rows = await Comment.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    res.json({ comments: page.map(comments.publicComment), nextCursor: rows.length > limit ? cursorFor(page.at(-1)) : null });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  const { articleId } = req.body || {};
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !['articleId', 'displayName', 'body'].includes(key))) {
    return reject(req, res, 400, 'INVALID_COMMENT');
  }
  const body = trimmed(req.body?.body, 2000);
  const displayName = req.user ? trimmed(req.user.displayName, 100) : trimmed(req.body?.displayName, 100);
  if (!validId(articleId) || !body || !displayName) return reject(req, res, 400, 'INVALID_COMMENT');
  try {
    const outcome = req.user
      ? await comments.createAuthenticatedComment({ articleId, body, user: req.user })
      : await comments.createGuestComment({ articleId, displayName, body, deviceId: req.deviceId });
    if (outcome.kind === 'notFound') return reject(req, res, 404, 'ARTICLE_NOT_FOUND');
    if (outcome.kind === 'limited') {
      logEvent('warn', 'comment.rejected', { outcome: 'rejected', reason: 'COMMENT_RATE_LIMIT', status: 429, articleId });
      res.set('Retry-After', String(outcome.retryAfterSeconds));
      return res.status(429).json({
        error: 'COMMENT_RATE_LIMIT',
        message: 'You can post three comments per minute. Please try again shortly.',
        retryAfterSeconds: outcome.retryAfterSeconds
      });
    }
    logEvent('info', 'comment.create', { outcome: 'success', commentId: outcome.comment.id, articleId, actorId: req.user?.id });
    res.status(201).json({ comment: outcome.comment });
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') return reject(req, res, 400, 'INVALID_COMMENT');
    next(error);
  }
}

async function read(req, res, next) {
  if (!validId(req.params.id)) return reject(req, res, 400, 'INVALID_COMMENT_ID');
  try {
    const comment = await Comment.findById(req.params.id).lean();
    if (!comment || !await comments.publishedArticleExists(comment.article)) return reject(req, res, 404, 'COMMENT_NOT_FOUND');
    res.json({ comment: comments.publicComment(comment) });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  if (!validId(req.params.id)) return reject(req, res, 400, 'INVALID_COMMENT_ID');
  const body = trimmed(req.body?.body, 2000);
  if (!body || Object.keys(req.body).some(key => key !== 'body')) return reject(req, res, 400, 'INVALID_COMMENT');
  try {
    const comment = await Comment.findByIdAndUpdate(req.params.id, { $set: { body } }, { returnDocument: 'after', runValidators: true });
    if (!comment) return reject(req, res, 404, 'COMMENT_NOT_FOUND');
    logEvent('info', 'comment.update', { outcome: 'success', commentId: req.params.id, actorId: req.user?.id });
    res.json({ comment: comments.publicComment(comment) });
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') return reject(req, res, 400, 'INVALID_COMMENT');
    next(error);
  }
}

async function remove(req, res, next) {
  if (!validId(req.params.id)) return reject(req, res, 400, 'INVALID_COMMENT_ID');
  try {
    const deleted = await Comment.findByIdAndDelete(req.params.id);
    if (!deleted) return reject(req, res, 404, 'COMMENT_NOT_FOUND');
    logEvent('info', 'comment.delete', { outcome: 'success', commentId: req.params.id, actorId: req.user?.id });
    res.status(204).end();
  } catch (error) { next(error); }
}

module.exports = { list, create, read, update, remove };
