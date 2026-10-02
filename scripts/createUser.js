const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const { ROLES } = require('../config/constants');
const User = require('../models/User');

async function main() {
  const [username, displayName, role] = process.argv.slice(2);
  const password = process.env.NEW_USER_PASSWORD;
  if (!username || !displayName || ![ROLES.REPORTER, ROLES.EDITOR].includes(role) || !password) {
    throw new Error('Usage: set NEW_USER_PASSWORD, then run node scripts/createUser.js <username> <displayName> <reporter|editor>.');
  }
  const user = new User({ username, displayName, role });
  await user.setPassword(password);
  await user.validate();
  await connectDatabase(process.env.MONGODB_URI);
  await user.save();
  console.log(`Created ${role} account: ${user.username}`);
}

main().catch(error => {
  console.error(error.code === 11000 ? 'Username already exists.' : error.message);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
