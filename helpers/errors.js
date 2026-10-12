const messages = {
  INVALID_INPUT: 'Enter a username and password.',
  INVALID_CREDENTIALS: 'Invalid username or password.',
  AUTH_REQUIRED: 'Sign in to continue.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  INVALID_COMMENT: 'Check your name (1–100 characters) and comment (1–2,000 characters).',
  INVALID_COMMENT_ID: 'The comment ID is invalid.',
  INVALID_COMMENT_QUERY: 'Check the article ID and comment pagination options.',
  ARTICLE_NOT_FOUND: 'This article is no longer available.',
  COMMENT_NOT_FOUND: 'This comment is no longer available.',
  INVALID_JSON: 'The request contains invalid JSON.',
  PAYLOAD_TOO_LARGE: 'The request is too large. Reduce its size and try again.',
  INTERNAL_SERVER_ERROR: 'We could not complete your request. Please try again later.',
  NOT_FOUND: 'The requested page or resource was not found.'
};

function errorBody(code) {
  return { error: code, message: messages[code] };
}

module.exports = { errorBody };
