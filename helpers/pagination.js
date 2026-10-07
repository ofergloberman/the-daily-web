const MAX_PAGE = 10000;

// Returns a positive whole page number, or null when the value is not a valid page.
function parsePage(value) {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= MAX_PAGE ? page : null;
}

module.exports = { parsePage };
