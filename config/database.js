const mongoose = require('mongoose');

async function connectDatabase(uri) {
  if (!uri) throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure MongoDB.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log('MongoDB connected');
}

module.exports = { connectDatabase };
