const router = require('express').Router();
const auth = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');

router.get('/', auth.showLogin);
router.post('/login', auth.login);
router.post('/logout', auth.logout);
router.get('/me', requireAuth, auth.me);
module.exports = router;
