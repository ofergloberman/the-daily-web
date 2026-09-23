const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  displayName: { type: String, required: true, trim: true, maxlength: 100 },
  body: { type: String, required: true, trim: true, maxlength: 2000 }
}, { timestamps: true });

commentSchema.index({ article: 1, createdAt: -1 });
module.exports = mongoose.model('Comment', commentSchema);
