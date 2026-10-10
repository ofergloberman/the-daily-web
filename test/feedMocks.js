// Shared test helper: makes the homepage feed queries return no articles without a database.
const Article = require('../models/Article');

function mockEmptyFeed(t) {
  t.mock.method(Article, 'find', () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, populate() { return this; }, async lean() { return []; } }));
  t.mock.method(Article, 'distinct', async () => []);
}

module.exports = { mockEmptyFeed };
