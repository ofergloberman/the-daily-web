const mongoose = require('mongoose');
const { DISPLAY_NAME_MAX_LENGTH, COMMENT_BODY_MAX_LENGTH } = require('../config/constants');

const commentSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  displayName: { type: String, required: true, trim: true, maxlength: DISPLAY_NAME_MAX_LENGTH },
  body: { type: String, required: true, trim: true, maxlength: COMMENT_BODY_MAX_LENGTH }
}, { timestamps: true });

commentSchema.index({ article: 1, createdAt: -1, _id: -1 });
module.exports = mongoose.model('Comment', commentSchema);
