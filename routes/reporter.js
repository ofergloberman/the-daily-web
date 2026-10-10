const router = require('express').Router();
const reporter = require('../controllers/reporterController');

router.get('/', reporter.dashboard);
router.get('/articles', reporter.listArticles);
router.post('/articles', reporter.createArticle);
router.get('/articles/:id/edit', reporter.editArticle);
router.patch('/articles/:id/draft', reporter.saveDraft);
router.post('/articles/:id/submit', reporter.submitArticle);

module.exports = router;
