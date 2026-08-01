// Undo the connector's int→bool coercion.
//
// On real hardware every claude.* frame is re-encoded as MessagePack by the Mac
// connector, whose `MessagePackValue.wrap` tries `case let b as Bool` *before*
// its NSNumber arm. On Darwin an NSNumber holding 0 or 1 does cast to Bool, so
// any integer that happens to be 0 or 1 arrives here as false/true — one busy
// session renders as "TRUE WORKING", a 100% context meter (1.0) becomes true,
// "1%" in usage becomes true. Counts of 2+ are unaffected, which is why this
// only ever showed up on small numbers.
//
// wrap() lives in upstream nocturne-connector, so the device undoes the damage
// instead: a boolean sitting on a field we know is numeric becomes 0/1 again.
// Genuine booleans (pendingPermission, ended, multiSelect, connected, stale,
// expired) are absent from the list and pass through untouched.

var NUMERIC = {
  // Snapshot envelope — tzOffsetMin is 0 in UTC, which coerces to false
  serverNowMs: true, tzOffsetMin: true,
  // Stats
  active: true, attention: true,
  // SessionSummary / SessionDetail
  lastActivityTs: true, in: true, out: true, context: true,
  contextTokens: true, cacheRead: true, startedTs: true,
  // Ask / permission
  createdTs: true, timeoutMs: true, expiredTs: true,
  // Usage
  updatedTs: true, used: true, requests: true, sessions: true, pct: true,
};

// Mutates in place — every caller hands over a freshly parsed frame.
export function unbool(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) unbool(value[i]);
    return value;
  }
  for (var k in value) {
    var v = value[k];
    if (typeof v === 'boolean') {
      if (NUMERIC[k] === true) value[k] = v ? 1 : 0;
    } else if (v && typeof v === 'object') {
      unbool(v);
    }
  }
  return value;
}
