const router = require('express').Router();
const controller = require('../controllers/commentsController');
const { requireEditor } = require('../middleware/auth');

router.route('/').get(controller.list).post(controller.create);
router.route('/:id').get(controller.read).patch(requireEditor, controller.update).delete(requireEditor, controller.remove);
module.exports = router;
