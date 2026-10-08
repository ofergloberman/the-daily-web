// A standalone mongod accepts connections but cannot commit multi-document transactions.
async function verifyTransactions(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if ((!hello.setName && hello.msg !== 'isdbgrid') || hello.logicalSessionTimeoutMinutes == null) {
    throw new Error('MongoDB transactions require a replica set or a compatible sharded deployment. See README.comments-api.md.');
  }

  const collection = connection.db.collection('transaction_probes');
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const session = await connection.startSession();
  try {
    // Exercise a real write and commit with the application's database permissions.
    await session.withTransaction(async () => {
      const result = await collection.insertOne({ expiresAt: new Date() }, { session });
      await collection.deleteOne({ _id: result.insertedId }, { session });
    });
  } finally {
    await session.endSession();
  }
}

module.exports = { verifyTransactions };
