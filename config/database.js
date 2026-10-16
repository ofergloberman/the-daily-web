const mongoose = require('mongoose');
const { verifyTransactions } = require('./transactions');

const SERVER_SELECTION_TIMEOUT_MS = 5000;
// Same value as the server selection timeout, so a request fails in seconds instead of hanging for Mongoose's default ten.
const DB_BUFFER_TIMEOUT_MS = 5000;

// One listener per event, registered once, so every outage and recovery is logged. The URI is never printed.
function logConnectionEvents(connection) {
  connection.on('disconnected', () => console.warn('MongoDB disconnected'));
  connection.on('reconnected', () => console.log('MongoDB reconnected'));
}

async function connectDatabase(uri) {
  if (!uri) throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure MongoDB.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, bufferTimeoutMS: DB_BUFFER_TIMEOUT_MS });
  logConnectionEvents(mongoose.connection);
  await verifyTransactions(mongoose.connection);
  console.log('MongoDB connected');
}

module.exports = { SERVER_SELECTION_TIMEOUT_MS, DB_BUFFER_TIMEOUT_MS, logConnectionEvents, connectDatabase };
