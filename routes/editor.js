const router = require('express').Router();
const editor = require('../controllers/editorController');
const actions = require('../controllers/editorActionsController');

router.get('/', editor.dashboard);
router.route('/articles/:id')
  .get(editor.reviewArticle)
  .patch(actions.editArticle)
  .delete(actions.deleteArticle);
router.post('/articles/:id/approve', actions.approveArticle);
router.post('/articles/:id/return', actions.returnArticle);

module.exports = router;
