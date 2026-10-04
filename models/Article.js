const mongoose = require('mongoose');
const { ARTICLE_STATUSES } = require('../config/constants');

// Draft fields may be empty during autosave. Validate completeness on submission.
const contentSchema = new mongoose.Schema({
  title: { type: String, trim: true, maxlength: 200, default: '' },
  summary: { type: String, trim: true, maxlength: 500, default: '' },
  body: { type: String, default: '' },
  category: { type: String, trim: true, maxlength: 80, default: '' },
  imageUrl: { type: String, trim: true, default: '' }
}, { _id: false });

const articleSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  draft: { type: contentSchema, default: () => ({}) },
  // Public readers use this approved snapshot, even while draft changes.
  published: { type: contentSchema, default: null },
  status: { type: String, enum: Object.values(ARTICLE_STATUSES), default: ARTICLE_STATUSES.DRAFT, required: true },
  editorNote: { type: String, trim: true, maxlength: 2000, default: '' },
  publishedAt: { type: Date, default: null },
  lastPublishedAt: { type: Date, default: null },
  // Identifies the exact PublicationEvent whose content is currently live, so a
  // page/visit response can record against the publication it actually served.
  currentPublication: { type: mongoose.Schema.Types.ObjectId, ref: 'PublicationEvent', default: null },
  // Indexed popularity counter kept consistent with ViewStatistic bucket totals by D4.
  totalViews: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

articleSchema.index({ author: 1, status: 1 });
articleSchema.index({ publishedAt: -1 });
articleSchema.index({ totalViews: -1 });
articleSchema.index({ 'published.category': 1, publishedAt: -1 });
articleSchema.index({ 'published.title': 'text' });
module.exports = mongoose.model('Article', articleSchema);
