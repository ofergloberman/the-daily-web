// Single place for how the site shows dates. Readers are in Israel, so format in Israel time whatever the host timezone is.
const SITE_TIME_ZONE = 'Asia/Jerusalem';
const STYLES = { short: 'short', long: 'long' };

function formatDate(value, style = 'short') {
  if (value == null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: STYLES[style] || 'short', day: 'numeric', timeZone: SITE_TIME_ZONE });
}

module.exports = { SITE_TIME_ZONE, formatDate };
