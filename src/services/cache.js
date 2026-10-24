const { currentScope } = require('./tenantScope');

// One cached value per company scope, so a list built for one company is
// never served to another. Callers use it like a single value; the scope
// of the current request picks the slot. clear() empties every slot.
function scopeKey() {
  const scope = currentScope();
  if (!scope) return 'owner';
  return scope.orgIds ? [...scope.orgIds].sort().join(',') : 'all';
}

function createCache(ttlMs) {
  const slots = new Map(); // scope key -> { data, expiry }
  return {
    isValid() {
      const slot = slots.get(scopeKey());
      return Boolean(slot) && Date.now() < slot.expiry;
    },
    get data() { return slots.get(scopeKey())?.data ?? null; },
    set(value) { slots.set(scopeKey(), { data: value, expiry: Date.now() + ttlMs }); },
    clear() { slots.clear(); },
  };
}

const studentsCache = createCache(30 * 1000);  // 30s
const advisorsCache = createCache(60 * 1000);  // 60s

module.exports = { studentsCache, advisorsCache };
