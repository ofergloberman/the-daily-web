const router = require('express').Router();
const { notImplemented } = require('../controllers/scaffoldController');

router.get('/', notImplemented);
router.post('/login', notImplemented);
router.post('/logout', notImplemented);
router.get('/me', notImplemented);
module.exports = router;
