// "This student's record or documents changed." Emitted by the storage
// layer after every successful write; the PDF backup listens (so storage
// never has to know about backups, and there's no require cycle).
const { EventEmitter } = require('events');

const events = new EventEmitter();
events.setMaxListeners(20);

// ref: a student storage reference ({ kind, key, orgId, ... }).
function studentChanged(ref) {
  if (!ref || !ref.key || !ref.orgId) return;
  // A listener must never break the save that triggered it.
  try { events.emit('changed', ref); } catch (err) { console.error('[events] listener failed:', err.message); }
}

module.exports = { events, studentChanged };
