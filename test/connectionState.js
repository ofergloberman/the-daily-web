// Tests run without MongoDB, so the connection reads "disconnected" unless a test says otherwise.
const mongoose = require('mongoose');

// readyState is a prototype getter; an own property hides it for the test and delete brings it back.
function stubReadyState(t, state) {
  Object.defineProperty(mongoose.connection, 'readyState', { value: state, configurable: true });
  t.after(() => { delete mongoose.connection.readyState; });
}

const stubConnected = t => stubReadyState(t, mongoose.STATES.connected);
const stubDisconnected = t => stubReadyState(t, mongoose.STATES.disconnected);

module.exports = { stubConnected, stubDisconnected };
