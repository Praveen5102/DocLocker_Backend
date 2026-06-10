function createCache(ttlMs) {
  let _data = null;
  let _expiry = 0;
  return {
    isValid() { return _data !== null && Date.now() < _expiry; },
    get data() { return _data; },
    set(value) { _data = value; _expiry = Date.now() + ttlMs; },
    clear() { _data = null; _expiry = 0; },
  };
}

const studentsCache = createCache(30 * 1000);  // 30s
const advisorsCache = createCache(60 * 1000);  // 60s

module.exports = { studentsCache, advisorsCache };
