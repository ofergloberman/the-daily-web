const mongoose = require('mongoose');

// One record per successful publication; draft edits do not create events.
const publicationEventSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  editor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publishedAt: { type: Date, required: true },
  kind: { type: String, enum: ['initial', 'update'], required: true }
}, { timestamps: true });

publicationEventSchema.index({ article: 1, publishedAt: 1 });
module.exports = mongoose.model('PublicationEvent', publicationEventSchema);
