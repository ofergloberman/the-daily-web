const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const GuestCommentLimit = require('../models/GuestCommentLimit');

const WINDOW_MS = 60000;
const MAX_COMMENTS = 3;
const MAX_RETRIES = 20;

function publicComment(comment) {
  return {
    id: String(comment._id), articleId: String(comment.article),
    displayName: comment.displayName, body: comment.body,
    createdAt: comment.createdAt.toISOString()
  };
}

async function publishedArticleExists(articleId, session) {
  const query = Article.exists({ _id: articleId, published: { $ne: null } });
  return Boolean(await (session ? query.session(session) : query));
}

function retryable(error) {
  return error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError');
}

async function createGuestComment({ articleId, displayName, body, deviceId, clock = () => new Date() }) {
  const deviceKey = createHash('sha256').update(deviceId).digest('hex');
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let outcome;
      await session.withTransaction(async () => {
        if (!await publishedArticleExists(articleId, session)) {
          outcome = { kind: 'notFound' };
          return;
        }

        const now = clock();
        const cutoff = new Date(now.getTime() - WINDOW_MS);
        const limit = await GuestCommentLimit.findById(deviceKey).session(session).lean();
        const recent = (limit?.successfulAt || []).filter(time => time > cutoff && time <= now);
        if (recent.length >= MAX_COMMENTS) {
          outcome = {
            kind: 'limited',
            retryAfterSeconds: Math.max(1, Math.ceil((recent[0].getTime() + WINDOW_MS - now.getTime()) / 1000))
          };
          return;
        }

        await GuestCommentLimit.updateOne(
          { _id: deviceKey },
          { $set: { successfulAt: [...recent, now], updatedAt: now } },
          { upsert: true, session }
        );
        const comment = new Comment({ article: articleId, author: null, displayName, body });
        await comment.save({ session });
        outcome = { kind: 'created', comment: publicComment(comment) };
      });
      return outcome;
    } catch (error) {
      if (!retryable(error) || attempt === MAX_RETRIES - 1) throw error;
      // Duplicate-key races occur when several transactions create a device row at once.
      await new Promise(resolve => setTimeout(resolve, Math.min(5 * (attempt + 1), 50)));
    } finally {
      await session.endSession();
    }
  }
}

async function createAuthenticatedComment({ articleId, body, user }) {
  if (!await publishedArticleExists(articleId)) return { kind: 'notFound' };
  const comment = await Comment.create({
    article: articleId, author: user._id, displayName: user.displayName, body
  });
  return { kind: 'created', comment: publicComment(comment) };
}

module.exports = { publicComment, publishedArticleExists, createGuestComment, createAuthenticatedComment };
