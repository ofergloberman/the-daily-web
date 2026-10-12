const mongoose = require('mongoose');
const User = require('./User');
const Session = require('./Session');
const Article = require('./Article');
const Comment = require('./Comment');
const PublicationEvent = require('./PublicationEvent');
const { logEvent } = require('../helpers/logging');

class MaintenanceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function invalid(message) { throw new MaintenanceError('INVALID_INPUT', message); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) invalid('Unsupported fields.');
}
function username(value) {
  if (typeof value !== 'string') invalid('Username must be text.');
  const result = value.trim().toLowerCase();
  if (!result || result.length > 50 || /[\s\p{Cc}]/u.test(result)) invalid('Username must be 1–50 characters without whitespace or controls.');
  return result;
}
function profile(input, creating = false) {
  fields(input, ['username', 'displayName', 'role']);
  if (!Object.keys(input).length) invalid('Specify at least one field.');
  const result = {};
  if (creating || Object.hasOwn(input, 'username')) result.username = username(input.username);
  if (creating || Object.hasOwn(input, 'displayName')) {
    if (typeof input.displayName !== 'string' || !input.displayName.trim() ||
        input.displayName.trim().length > 100 || /\p{Cc}/u.test(input.displayName)) invalid('Display name must be 1–100 characters without controls.');
    result.displayName = input.displayName.trim();
  }
  if (creating || Object.hasOwn(input, 'role')) {
    if (!['reporter', 'editor'].includes(input.role)) invalid('Role must be reporter or editor.');
    result.role = input.role;
  }
  return result;
}
function selector(input) {
  fields(input, ['id', 'username']);
  if (Object.keys(input).length !== 1) invalid('Specify exactly one of id or username.');
  if (Object.hasOwn(input, 'username')) return { username: username(input.username) };
  if (typeof input.id !== 'string' || !/^[a-f0-9]{24}$/i.test(input.id)) invalid('Invalid user ID.');
  return { _id: input.id };
}
function safeUser(user) {
  return { id: String(user._id), username: user.username, displayName: user.displayName,
    role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
}
async function safeOperation(callback) {
  try { return await callback(); }
  catch (error) {
    if (error instanceof MaintenanceError) throw error;
    if (error.code === 11000) throw new MaintenanceError('DUPLICATE_USERNAME', 'Username already exists.');
    if (error.name === 'ValidationError') throw new MaintenanceError('INVALID_INPUT', 'Invalid account data.');
    throw new MaintenanceError('DATABASE_FAILURE', 'Database operation failed; check database availability and transaction support.');
  }
}
async function findUser(query, session) {
  const user = await User.findOne(query).session(session || null);
  if (!user) throw new MaintenanceError('USER_NOT_FOUND', 'Account not found.');
  return user;
}
function passwordInput(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) invalid('Password must be 8–128 characters.');
}
// Caller must stop application/seed writers; see USER_MAINTENANCE.md.
async function createUser(input, password) {
  const data = profile(input, true);
  passwordInput(password);
  return safeOperation(async () => {
    const user = new User(data);
    await user.setPassword(password);
    await user.save();
    return safeUser(user);
  });
}
async function readUser(input) {
  const query = selector(input);
  return safeOperation(async () => safeUser(await findUser(query)));
}
async function listUsers(options = {}) {
  fields(options, ['search', 'limit', 'offset']);
  const { search = '', limit = 20, offset = 0 } = options;
  if (typeof search !== 'string' || search.length > 50 || /\p{Cc}/u.test(search)) invalid('Search must be at most 50 characters without controls.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) invalid('Limit must be 1–100; offset must be 0–10000.');
  // Literal prefix search uses the username index; input cannot inject regex operators.
  const escaped = search.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safeOperation(async () => (await User.find(escaped ? { username: { $regex: `^${escaped}` } } : {})
    .sort({ username: 1 }).skip(offset).limit(limit)).map(safeUser));
}
async function changeUser(input, changes, password, deleting = false) {
  const query = selector(input);
  return safeOperation(() => mongoose.connection.transaction(async session => {
    const user = await findUser(query, session);
    const revoke = deleting || password !== undefined || (changes.role !== undefined && changes.role !== user.role);
    if (deleting) {
      const blockers = [];
      // Queries stay sequential: parallel operations in a transaction are unsupported.
      for (const [Model, field, label] of [[Article, 'author', 'articles'], [Comment, 'author', 'comments'], [PublicationEvent, 'editor', 'publication events']]) {
        if (await Model.exists({ [field]: user._id }).session(session)) blockers.push(label);
      }
      if (blockers.length) throw new MaintenanceError('USER_REFERENCED', `Deletion blocked by ${blockers.join(', ')}. Preserve or explicitly resolve references first.`);
      await user.deleteOne({ session });
    } else {
      Object.assign(user, changes);
      if (password !== undefined) await user.setPassword(password);
      await user.save({ session });
    }
    if (revoke) await Session.deleteMany({ user: user._id }, { session });
    return safeUser(user);
  }));
}
async function updateUser(input, changes) { return changeUser(input, profile(changes)); }
async function resetPassword(input, password) { passwordInput(password); return changeUser(input, {}, password); }
async function deleteUser(input) { return changeUser(input, {}, undefined, true); }

// Log at the operation boundary, after a transaction has committed. Transaction
// callbacks can be retried and must not emit premature or duplicate success logs.
function audited(operation, callback, writes = true) {
  return async (...args) => {
    try {
      const result = await callback(...args);
      if (writes) logEvent('info', `account.${operation}`, { outcome: 'success', userId: result.id, scope: 'maintenance' });
      return result;
    } catch (error) {
      const reason = error instanceof MaintenanceError ? error.code : 'DATABASE_FAILURE';
      logEvent(reason === 'DATABASE_FAILURE' ? 'error' : 'warn', `account.${operation}`,
        { outcome: reason === 'DATABASE_FAILURE' ? 'failure' : 'rejected', reason, scope: 'maintenance' });
      throw error;
    }
  };
}

module.exports = { MaintenanceError,
  createUser: audited('create', createUser), readUser: audited('read', readUser, false),
  listUsers: audited('list', listUsers, false), updateUser: audited('update', updateUser),
  resetPassword: audited('reset-password', resetPassword), deleteUser: audited('delete', deleteUser) };
