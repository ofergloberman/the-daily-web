const analytics = require('../models/analyticsOperations');

// Counting must never delay or break an article page; the caller handles failures.
async function recordVisit(article) {
  const publicationId = await analytics.findLatestPublicationId(article._id);
  // Fixture or legacy articles can have a snapshot without a publication event; there is nothing to attribute the view to.
  if (!publicationId) return;
  await analytics.recordVisit(article._id, publicationId);
}

module.exports = { recordVisit };
