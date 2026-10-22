const router = require('express').Router();
const { listArticles, showArticle } = require('../controllers/publicArticleController');

router.get('/', listArticles);
router.get('/:id', showArticle);
module.exports = router;
