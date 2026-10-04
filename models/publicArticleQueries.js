const Article = require('./Article');

// Public reads see only the approved snapshot. Never select draft or editorNote here.
const PUBLIC_FIELDS = 'published publishedAt lastPublishedAt author';
const CARD_FIELDS = 'published.title published.summary published.category published.imageUrl publishedAt author';
const PUBLISHED = { published: { $ne: null } };

function findPublicById(id) {
  return Article.findOne({ _id: id, ...PUBLISHED })
    .select(PUBLIC_FIELDS).populate('author', 'displayName').lean();
}

function findLatestPublic(limit) {
  return Article.find(PUBLISHED).select(CARD_FIELDS).sort({ publishedAt: -1, _id: -1 })
    .limit(limit).populate('author', 'displayName').lean();
}

module.exports = { PUBLIC_FIELDS, CARD_FIELDS, findPublicById, findLatestPublic };
