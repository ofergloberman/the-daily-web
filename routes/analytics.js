const router = require('express').Router();
const analytics = require('../controllers/analyticsController');

router.get('/', analytics.showPage);
router.get('/articles', analytics.searchArticles);
router.get('/articles/:id/views', analytics.viewSeries);

module.exports = router;
