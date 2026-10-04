const router = require('express').Router();
const { notImplemented } = require('../controllers/scaffoldController');
const { showArticle } = require('../controllers/publicArticleController');

router.route('/').get(notImplemented).post(notImplemented);
router.route('/:id').get(showArticle).patch(notImplemented).delete(notImplemented);
module.exports = router;
