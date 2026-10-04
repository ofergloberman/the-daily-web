const Article = require('./Article');

// Public reads see only the approved snapshot. Never select draft or editorNote here.
const PUBLIC_FIELDS = 'published publishedAt lastPublishedAt author';

function findPublicById(id) {
  return Article.findOne({ _id: id, published: { $ne: null } })
    .select(PUBLIC_FIELDS).populate('author', 'displayName').lean();
}

module.exports = { PUBLIC_FIELDS, findPublicById };
