const router = require('express').Router();
const editor = require('../controllers/editorController');

router.get('/', editor.dashboard);
router.get('/articles/:id', editor.reviewArticle);

module.exports = router;
