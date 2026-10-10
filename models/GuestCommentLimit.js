const mongoose = require('mongoose');

const guestCommentLimitSchema = new mongoose.Schema({
  // A hash of the persistent device cookie; never return this model to clients.
  _id: { type: String, required: true },
  successfulAt: { type: [Date], default: [] },
  updatedAt: { type: Date, required: true }
}, { versionKey: false });

guestCommentLimitSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 120 });
module.exports = mongoose.model('GuestCommentLimit', guestCommentLimitSchema);
