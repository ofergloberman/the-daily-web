const router = require('express').Router();
const { notImplemented } = require('../controllers/scaffoldController');

router.route('/').get(notImplemented).post(notImplemented);
router.route('/:id').get(notImplemented).patch(notImplemented).delete(notImplemented);
module.exports = router;
