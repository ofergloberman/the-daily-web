// Local D3 fixtures: 45 published articles (three feed batches) and 1 draft. Runs only against a database whose name ends in _dev3.
const mongoose = require('mongoose');
const { randomBytes } = require('node:crypto');
const { connectDatabase } = require('../config/database');
const { ROLES, ARTICLE_STATUSES } = require('../config/constants');
const User = require('../models/User');
const Article = require('../models/Article');

const CATEGORIES = ['World', 'Politics', 'Tech', 'Sport', 'Culture'];
const TOPICS = ['election', 'budget', 'startup', 'final', 'festival', 'climate', 'transit', 'housing', 'museum'];

async function main() {
  await connectDatabase(process.env.MONGODB_URI);
  if (!mongoose.connection.name.endsWith('_dev3')) throw new Error(`Refusing to seed database "${mongoose.connection.name}". Use a database name ending in _dev3.`);
  let author = await User.findOne({ username: 'dev3-fixture' });
  if (!author) {
    author = new User({ username: 'dev3-fixture', displayName: 'Fixture Reporter', role: ROLES.REPORTER });
    await author.setPassword(randomBytes(24).toString('hex'));
    await author.save();
  }
  await Article.deleteMany({ author: author._id });
  const now = Date.now();
  const published = Array.from({ length: 45 }, (_, i) => {
    const content = {
      title: `Fixture story ${i + 1}: ${TOPICS[i % TOPICS.length]} ${CATEGORIES[i % CATEGORIES.length]} update`,
      summary: `Summary for fixture story ${i + 1}.`,
      body: `Opening paragraph of fixture story ${i + 1}.\nSecond paragraph with more detail.\nClosing paragraph.`,
      category: CATEGORIES[i % CATEGORIES.length],
      imageUrl: i % 2 ? '' : `https://picsum.photos/seed/dailyweb${i}/900/600`
    };
    const publishedAt = new Date(now - i * 3600e3);
    return { author: author._id, draft: content, published: content, status: ARTICLE_STATUSES.PUBLISHED, publishedAt, lastPublishedAt: publishedAt, totalViews: (i * 37) % 11 };
  });
  const draft = { author: author._id, draft: { title: 'Fixture draft that must stay private', body: 'Draft only.' }, status: ARTICLE_STATUSES.DRAFT };
  const created = await Article.insertMany([...published, draft]);
  console.log(`Seeded ${created.length} articles into ${mongoose.connection.name}.`);
  console.log(`Published example: /articles/${created[0]._id}`);
  console.log(`Draft (expect 404): /articles/${created.at(-1)._id}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
