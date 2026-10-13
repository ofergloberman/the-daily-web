const mongoose = require('mongoose');

// Which articles a browser/device has opened. Membership only: repeated visits are counted by D4's
// analytics, while this collection keeps at most one record per device and article.
const viewedArticleSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  firstViewedAt: { type: Date, default: Date.now }
}, { versionKey: false });

viewedArticleSchema.index({ deviceId: 1, article: 1 }, { unique: true });
viewedArticleSchema.index({ article: 1 }); // Cleanup when an article is deleted.
// The device cookie lives a year (middleware/deviceIdentity.js), so older history can no longer be read.
viewedArticleSchema.index({ firstViewedAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

const DUPLICATE_KEY_ERROR = 11000;

// Idempotent: an upsert keyed by the unique index; two concurrent first visits can race to insert,
// and the loser's duplicate-key error means the record already exists.
viewedArticleSchema.statics.markViewed = async function (deviceId, articleId) {
  try {
    await this.updateOne({ deviceId, article: articleId }, { $setOnInsert: { firstViewedAt: new Date() } }, { upsert: true });
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY_ERROR) throw error;
  }
};

module.exports = mongoose.model('ViewedArticle', viewedArticleSchema);
