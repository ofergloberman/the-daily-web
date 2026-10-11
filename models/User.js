const mongoose = require('mongoose');
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { ROLES } = require('../config/constants');
const scrypt = promisify(scryptCallback);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 50 },
  displayName: { type: String, required: true, trim: true, maxlength: 100 },
  passwordHash: {
    type: String, required: true, select: false,
    validate: { validator: value => /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value), message: 'Use setPassword to create a password hash.' }
  },
  role: { type: String, enum: Object.values(ROLES), default: ROLES.GUEST, required: true }
}, { timestamps: true });

userSchema.set('toJSON', { transform(_doc, result) { delete result.passwordHash; return result; } });

userSchema.methods.setPassword = async function (password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Password must be 8 to 128 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  this.passwordHash = `scrypt:${salt}:${hash.toString('hex')}`;
};

userSchema.methods.verifyPassword = async function (password) {
  if (typeof password !== 'string' || typeof this.passwordHash !== 'string') return false;
  const parts = this.passwordHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const stored = Buffer.from(parts[2], 'hex');
  const supplied = await scrypt(password, parts[1], stored.length);
  return timingSafeEqual(stored, supplied);
};

module.exports = mongoose.model('User', userSchema);
