const mongoose = require('mongoose');
const User = require('./User');
const Session = require('./Session');
const Article = require('./Article');
const Comment = require('./Comment');
const PublicationEvent = require('./PublicationEvent');

class MaintenanceError extends Error {
  constructor(code, message) { super(message); this.name = 'MaintenanceError'; this.code = code; }
}
function invalid(message) { throw new MaintenanceError('INVALID_INPUT', message); }
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key))) invalid('Unsupported fields.');
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`${name} must be nonblank text of at most ${max} characters without control characters.`);
  }
  return value.trim();
}
function username(value) { return text(value, 'Username', 50).toLowerCase(); }
function accountFields(input) {
  const result = {};
  if (Object.hasOwn(input, 'username')) result.username = username(input.username);
  if (Object.hasOwn(input, 'displayName')) result.displayName = text(input.displayName, 'Display name', 100);
  if (Object.hasOwn(input, 'role')) {
    if (!['reporter', 'editor'].includes(input.role)) invalid('Role must be reporter or editor.');
    result.role = input.role;
  }
  return result;
}
function selector(input) {
  fields(input, ['id', 'username']);
  if (Object.keys(input).length !== 1) invalid('Supply exactly one ID or username.');
  if (Object.hasOwn(input, 'username')) return { username: username(input.username) };
  if (typeof input.id !== 'string' || !/^[a-f0-9]{24}$/i.test(input.id)) invalid('ID must be 24 hexadecimal characters.');
  return { _id: input.id };
}
function safeUser(user) {
  return { id: String(user._id), username: user.username, displayName: user.displayName, role: user.role,
    createdAt: user.createdAt, updatedAt: user.updatedAt };
}
async function guard(run) {
  try { return await run(); } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    if (error.code === 11000) throw new MaintenanceError('DUPLICATE_USERNAME', 'Username already exists.');
    // Never forward Mongoose errors, documents, connection strings or credentials.
    throw new MaintenanceError('DATABASE_FAILURE', 'Database operation failed. Check database availability and transaction support.');
  }
}
async function findAccount(filter, session = null) {
  const user = await User.findOne(filter).session(session);
  if (!user) throw new MaintenanceError('NOT_FOUND', 'Account not found.');
  return user;
}
async function setPassword(user, password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) invalid('Password must be 8 to 128 characters.');
  await user.setPassword(password);
}
async function createUser(input, password) {
  fields(input, ['username', 'displayName', 'role']);
  if (!['username', 'displayName', 'role'].every(key => Object.hasOwn(input, key))) invalid('Username, display name and role are required.');
  const user = new User(accountFields(input));
  await setPassword(user, password);
  return guard(async () => { await User.init(); await user.save(); return safeUser(user); });
}
async function readUser(input) {
  const filter = selector(input);
  return guard(async () => safeUser(await findAccount(filter)));
}
async function listUsers(input = {}) {
  fields(input, ['search', 'limit', 'after']);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Limit must be an integer from 1 to 100.');
  const filter = {};
  if (input.search !== undefined) {
    const prefix = username(input.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.username = { $regex: `^${prefix}` };
  }
  if (input.after !== undefined) filter.username = { ...filter.username, $gt: username(input.after) };
  return guard(async () => {
    const rows = await User.find(filter).select('username displayName role createdAt updatedAt').sort({ username: 1 }).limit(limit + 1).lean();
    return { users: rows.slice(0, limit).map(safeUser), nextAfter: rows.length > limit ? rows[limit - 1].username : null };
  });
}
async function updateUser(input, patch) {
  const filter = selector(input);
  fields(patch, ['username', 'displayName', 'role']);
  if (!Object.keys(patch).length) invalid('At least one update field is required.');
  const changes = accountFields(patch);
  return guard(() => mongoose.connection.transaction(async session => {
    const user = await findAccount(filter, session);
    const revoke = changes.role !== undefined && changes.role !== user.role;
    Object.assign(user, changes);
    if (revoke) user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save({ session });
    if (revoke) await Session.deleteMany({ user: user._id }, { session });
    return safeUser(user);
  }));
}
async function resetPassword(input, password) {
  const filter = selector(input);
  const credentials = new User();
  await setPassword(credentials, password);
  return guard(() => mongoose.connection.transaction(async session => {
    const user = await findAccount(filter, session);
    user.passwordHash = credentials.passwordHash;
    user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save({ session });
    await Session.deleteMany({ user: user._id }, { session });
    return safeUser(user);
  }));
}
async function deleteUser(input, { offline = false } = {}) {
  const filter = selector(input);
  if (offline !== true) invalid('Deletion requires offline maintenance: stop all application instances and other database writers, then pass --offline.');
  return guard(() => mongoose.connection.transaction(async session => {
    const user = await findAccount(filter, session);
    const references = [];
    // Sequential operations: parallel queries are not supported in a transaction.
    for (const [model, field, label] of [[Article, 'author', 'articles'], [Comment, 'author', 'comments'], [PublicationEvent, 'editor', 'publication events']]) {
      if (await model.exists({ [field]: user._id }).session(session)) references.push(label);
    }
    if (references.length) throw new MaintenanceError('USER_REFERENCED', `Cannot delete account: referenced by ${references.join(', ')}. No content or sessions were removed.`);
    await Session.deleteMany({ user: user._id }, { session });
    await User.deleteOne({ _id: user._id }, { session });
    return { deleted: safeUser(user) };
  }));
}
module.exports = { MaintenanceError, createUser, readUser, listUsers, updateUser, resetPassword, deleteUser };
