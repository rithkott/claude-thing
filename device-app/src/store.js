// App state: session snapshot, detail cache, permission queue, daemon link.

import { setTzOffset, setServerNow, now } from './clock.js';

var state = {
  sessions: [],
  stats: { active: 0, attention: 0 },
  details: {},          // id -> SessionDetail
  // Everything waiting on a human, oldest first. Two kinds:
  //   permission — {kind:'permission', id, sessionId, tool, summary, createdTs, timeoutMs}
  //   question   — {kind:'question', id, sessionId, header, question,
  //                 options:[{label, description}], multiSelect, createdTs}
  asks: [],
  usage: null,          // latest claude.usage.update payload
  daemonConnected: true,
  selectedIndex: 0,     // session grid cursor
  queueIndex: 0,        // queue list cursor
  queueAnswering: false, // question hero's option list is open in place
  queueChoice: 0,        // cursor within that list
  btDevices: [],        // [{address, name, paired, connected}]
  btDiscoverable: false,
  btIndex: 0,           // bluetooth cursor: 0 = pairing toggle, 1..n = devices
  btMenu: null,         // address of the device whose action submenu is open
  btMenuIndex: 0,       // cursor within that submenu
  btBusy: null,         // address with an in-flight connect/disconnect
  btPairing: null,      // {address, name, pin} while a phone is pairing
};

var subs = [];

export function get() { return state; }

export function subscribe(fn) { subs.push(fn); }

export function update(fields) {
  for (var k in fields) state[k] = fields[k];
  for (var i = 0; i < subs.length; i++) subs[i](state);
}

export function applySnapshot(snap) {
  setServerNow(snap.serverNowMs);
  setTzOffset(snap.tzOffsetMin);
  var sel = state.sessions[state.selectedIndex];
  var fields = { sessions: snap.sessions || [], stats: snap.stats || state.stats };
  // Details for sessions the daemon no longer lists would pile up forever on a
  // device that never reboots. A pruned detail costs one refetch (openSession
  // asks the daemon anyway); an unpruned map costs memory for every session
  // since boot.
  var keep = {};
  for (var j = 0; j < fields.sessions.length; j++) {
    var id = fields.sessions[j].id;
    if (state.details[id]) keep[id] = state.details[id];
  }
  // The one screen that reads a detail after its session leaves the snapshot:
  // a session that ends while you are looking at it. Its farewell detail says
  // "ended" — pruning it would blank the screen to LOADING….
  var h = (typeof window !== 'undefined' && window.location.hash) || '';
  if (h.indexOf('#/session/') === 0) {
    var open = h.slice('#/session/'.length);
    if (state.details[open]) keep[open] = state.details[open];
  }
  fields.details = keep;
  if (sel) {
    for (var i = 0; i < fields.sessions.length; i++) {
      if (fields.sessions[i].id === sel.id) { fields.selectedIndex = i; break; }
    }
  }
  if (fields.selectedIndex === undefined) {
    fields.selectedIndex = Math.min(state.selectedIndex, Math.max(0, fields.sessions.length - 1));
  }
  update(fields);
}

export function applyDetail(detail) {
  state.details[detail.id] = detail;
  update({});
}

export function pushAsk(ask) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === ask.id) return;
  }
  if (!ask.sessionName) ask.sessionName = sessionName(ask.sessionId);
  state.asks.push(ask);
  update({});
}

// A timed-out permission is not answered — it has moved to the terminal. It
// stays on the device saying so, because silently vanishing looks identical to
// somebody else having answered it.
export function expireAsk(id) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === id) {
      state.asks[i].expired = true;
      state.asks[i].expiredTs = now();
      update({});
      return true;
    }
  }
  return false;
}

// Expired entries are notices, not work, so they age out on their own.
export function sweepExpired(ttlMs) {
  var cutoff = now() - ttlMs;
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    var a = state.asks[i];
    if (a.expired && a.expiredTs < cutoff) continue;
    next.push(a);
  }
  if (next.length !== state.asks.length) {
    var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
    // The hero may have changed under an open option list; close it rather
    // than leave the list pointing at a different ask.
    update({ asks: next, queueIndex: qi, queueAnswering: false, queueChoice: 0 });
  }
}

export function resolveAsk(id) {
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id !== id) next.push(state.asks[i]);
  }
  var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
  update({ asks: next, queueIndex: qi, queueAnswering: false, queueChoice: 0 });
}

export function getAsk(id) {
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id === id) return state.asks[i];
  }
  return null;
}

export function sessionName(id) {
  for (var i = 0; i < state.sessions.length; i++) {
    if (state.sessions[i].id === id) return state.sessions[i].name;
  }
  var d = state.details[id];
  return d ? d.name : 'session';
}
