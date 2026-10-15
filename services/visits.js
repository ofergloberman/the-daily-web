const analytics = require('../models/analyticsOperations');

// Counting must never delay or break an article page; the caller handles failures.
function recordVisit(article) {
  // currentPublication is the version this reader was served; articles without one still count toward popularity.
  return analytics.recordVisit(article._id, article.currentPublication ?? null);
}

module.exports = { recordVisit };
