// Run as if hosted in UTC so a missing site timezone shows up on any developer machine.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SITE_TIME_ZONE, formatDate } = require('../helpers/dates');

test('formatDate shows the Israel calendar day whatever the host timezone', () => {
  assert.equal(SITE_TIME_ZONE, 'Asia/Jerusalem');
  assert.equal(new Date('2026-10-01T22:30:00Z').getDate(), 1);
  assert.equal(formatDate('2026-10-01T22:30:00Z'), 'Oct 2, 2026');
  assert.equal(formatDate(new Date('2026-10-01T22:30:00Z'), 'long'), 'October 2, 2026');
  assert.equal(formatDate('2026-01-15T21:59:00Z'), 'Jan 15, 2026');
  assert.equal(formatDate('2026-01-15T22:00:00Z'), 'Jan 16, 2026');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate(undefined), '');
});
