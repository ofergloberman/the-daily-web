function notImplemented(_req, res) {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'This endpoint is reserved for the next development stage.' });
}

module.exports = { notImplemented };
