const { randomBytes } = require('node:crypto');

const COOKIE_NAME = 'wd_device';
const COOKIE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function deviceIdentity(req, res, next) {
  const pair = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`));
  const deviceId = pair?.slice(COOKIE_NAME.length + 1);

  if (deviceId && /^[a-f0-9]{64}$/.test(deviceId)) {
    req.deviceId = deviceId;
  } else {
    req.deviceId = randomBytes(32).toString('hex');
    res.cookie(COOKIE_NAME, req.deviceId, {
      httpOnly: true, sameSite: 'lax', path: '/',
      maxAge: COOKIE_AGE_MS, secure: process.env.NODE_ENV === 'production'
    });
  }
  next();
}

module.exports = { deviceIdentity };
