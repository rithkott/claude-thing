// App state: session snapshot, detail cache, permission queue, daemon link.

import { setTzOffset } from './screens/helpers.js';

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
};

var subs = [];

export function get() { return state; }

export function subscribe(fn) { subs.push(fn); }

export function update(fields) {
  for (var k in fields) state[k] = fields[k];
  for (var i = 0; i < subs.length; i++) subs[i](state);
}

export function applySnapshot(snap) {
  setTzOffset(snap.tzOffsetMin);
  var sel = state.sessions[state.selectedIndex];
  var fields = { sessions: snap.sessions || [], stats: snap.stats || state.stats };
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
      state.asks[i].expiredTs = Date.now();
      update({});
      return true;
    }
  }
  return false;
}

// Expired entries are notices, not work, so they age out on their own.
export function sweepExpired(ttlMs) {
  var cutoff = Date.now() - ttlMs;
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    var a = state.asks[i];
    if (a.expired && a.expiredTs < cutoff) continue;
    next.push(a);
  }
  if (next.length !== state.asks.length) {
    var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
    update({ asks: next, queueIndex: qi });
  }
}

export function resolveAsk(id) {
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id !== id) next.push(state.asks[i]);
  }
  var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
  update({ asks: next, queueIndex: qi });
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
