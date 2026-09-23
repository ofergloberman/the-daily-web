const mongoose = require('mongoose');
const { ROLES } = require('../config/constants');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 50 },
  displayName: { type: String, required: true, trim: true, maxlength: 100 },
  // Authentication must hash passwords before saving; never store plaintext here.
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: Object.values(ROLES), default: ROLES.GUEST, required: true }
}, { timestamps: true });

userSchema.set('toJSON', { transform(_doc, result) { delete result.passwordHash; return result; } });
module.exports = mongoose.model('User', userSchema);
