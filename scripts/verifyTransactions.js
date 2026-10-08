const mongoose = require('mongoose');
const { verifyTransactions } = require('../config/transactions');

(async () => {
  try {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await verifyTransactions(mongoose.connection);
    console.log('MongoDB transaction write and commit verified.');
  } catch (error) {
    // Connection errors may contain credentials or private deployment addresses.
    console.error(`Transaction verification failed (${error.name}). Check MongoDB availability, replica-set configuration and database permissions. See README.comments-api.md.`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
