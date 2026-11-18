// Three-way merge of a student record, so one person's save never wipes
// another's newer work.
//
// Every editor (the student portal, a staff page) saves a whole record built
// from the copy it loaded earlier. That copy can be hours old: a staff member
// reassigning the advisor from a dashboard opened at 10:00 used to undo
// everything the student filled in at 10:30, and the student's next save
// used to drop a document staff uploaded for them.
//
// The editor now also sends the copy it started from (base). Only what it
// actually changed (base -> mine) is applied, on top of what is stored now
// (theirs). Where both changed the same value, the incoming save wins, as
// before.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

// Lists merged item by item rather than replaced whole. One parsed document
// per file, so a staff upload and a student upload to different slots both
// survive.
const KEYED_LISTS = {
  uploadedDocuments: (d) => (d && d.subFolder !== undefined ? `${d.subFolder}__${d.sourceFile}` : null),
};

function mergeKeyedList(base = [], mine = [], theirs = [], keyOf) {
  const index = (list) => {
    const m = new Map();
    for (const item of list) { const k = keyOf(item); if (k === null) return null; m.set(k, item); }
    return m;
  };
  const b = index(base), m = index(mine), t = index(theirs);
  if (!b || !m || !t) return mine; // not the shape we know: incoming wins
  const out = [];
  const keys = new Set([...t.keys(), ...m.keys()]);
  for (const k of keys) {
    const v = merge3(b.get(k), m.get(k), t.get(k));
    if (v !== undefined) out.push(v);
  }
  return out;
}

function merge3(base, mine, theirs, key) {
  if (same(mine, base)) return theirs; // this editor didn't touch it
  if (same(theirs, base) || same(mine, theirs)) return mine; // only this editor changed it
  if (key && KEYED_LISTS[key] && Array.isArray(mine) && Array.isArray(theirs)) {
    return mergeKeyedList(Array.isArray(base) ? base : [], mine, theirs, KEYED_LISTS[key]);
  }
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = merge3(b[k], mine[k], theirs[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine; // both changed the same value: the incoming save wins
}

// stored: the record as it is now. An empty stored record means it is
// missing (a new student, or a lost file) - never merge onto that, or a save
// would keep only its own edits; write the full incoming record instead.
function mergeRecord(base, mine, stored) {
  if (!isObj(base) || !isObj(mine)) return mine;
  if (!isObj(stored) || Object.keys(stored).length === 0) return mine;
  return merge3(base, mine, stored);
}

module.exports = { mergeRecord };
