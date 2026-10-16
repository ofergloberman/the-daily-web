// D3 scripts and the opt-in feed integration test write to the database. They must refuse anything but a
// database whose name ends in _dev3, and decide that from the URI before connecting: connecting already
// writes (the transaction probe, Mongoose collection and index creation).
function databaseName(uri) {
  // The query string comes first off, so an "@" or "/" inside it can never be mistaken for the host or the name.
  const rest = String(uri || '').replace(/^mongodb(\+srv)?:\/\//, '').split('?')[0];
  // Credentials percent-encode "@" and "/", so the hosts start after the last "@" and the name follows the first "/".
  const path = rest.slice(rest.lastIndexOf('@') + 1);
  const slash = path.indexOf('/');
  return slash === -1 ? '' : decodeURIComponent(path.slice(slash + 1));
}

function assertDev3Uri(uri) {
  const name = databaseName(uri);
  if (!name.endsWith('_dev3')) throw new Error(`Refusing to use database "${name || '(none in MONGODB_URI)'}". Use a database name ending in _dev3.`);
  return name;
}

module.exports = { databaseName, assertDev3Uri };
