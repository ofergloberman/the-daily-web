const { WorkflowError } = require('../models/articleWorkflow');

// The workflow expects a plain { id, role } actor, never the whole user document.
function actor(req) {
  return { id: req.user.id, role: req.user.role };
}

/** Sends the JSON error for a WorkflowError and returns true; returns false for any other error. */
function sendWorkflowError(res, error) {
  if (!(error instanceof WorkflowError)) return false;
  const body = { error: error.code, message: error.message };
  if (error.latest) body.latest = error.latest;
  res.status(error.status).json(body);
  return true;
}

module.exports = { actor, sendWorkflowError };
