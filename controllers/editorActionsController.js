const workflow = require('../models/articleWorkflow');
const { actor, sendWorkflowError } = require('../helpers/workflowResponse');

function articleResult(article) {
  return { id: String(article._id), status: article.status };
}

// Every state rule lives in the workflow; this only maps its result or WorkflowError to the JSON contract.
function actionHandler(logMessage, run) {
  return async (req, res, next) => {
    try {
      const data = await run(req);
      console.info(`${logMessage}:`, data.id);
      res.json({ data });
    } catch (error) {
      if (!sendWorkflowError(res, error)) next(error);
    }
  };
}

const approveArticle = actionHandler('Editor approved article', async req =>
  articleResult(await workflow.approve(req.params.id, actor(req))));

const returnArticle = actionHandler('Editor returned article', async req =>
  articleResult(await workflow.returnForCorrections(req.params.id, actor(req), req.body?.note)));

const editArticle = actionHandler('Editor edited article', async req =>
  articleResult(await workflow.editAsEditor(req.params.id, actor(req), req.body)));

const deleteArticle = actionHandler('Editor deleted article', async req => {
  await workflow.deleteArticle(req.params.id, actor(req));
  return { id: req.params.id };
});

module.exports = { approveArticle, returnArticle, editArticle, deleteArticle };
