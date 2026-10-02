const mongoose = require('mongoose');

// Separate publication buckets preserve before/after counts within the same minute.
const viewStatisticSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  publication: { type: mongoose.Schema.Types.ObjectId, ref: 'PublicationEvent', required: true },
  minute: {
    type: Date,
    required: true,
    validate: {
      validator: value => value.getTime() % 60000 === 0,
      message: 'minute must be the start of a UTC minute.'
    }
  },
  count: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: { validator: Number.isSafeInteger, message: 'count must be a safe integer.' }
  }
}, { timestamps: true });

viewStatisticSchema.index({ article: 1, minute: 1, publication: 1 }, { unique: true });
module.exports = mongoose.model('ViewStatistic', viewStatisticSchema);
