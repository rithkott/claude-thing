// App state: session snapshot, detail cache, permission queue, daemon link.

import { setTzOffset, setServerNow, now } from './clock.js';

var state = {
  sessions: [],
  stats: { active: 0, attention: 0 },
  details: {},          // id -> SessionDetail
  // Everything waiting on a human, oldest first. Two kinds:
  //   permission — {kind:'permission', id, sessionId, tool, summary, intent,
  //                 createdTs, timeoutMs}
  //   question   — {kind:'question', id, sessionId, intent, createdTs,
  //                 questions:[{header, question, options:[{label,
  //                 description}], multiSelect}]}
  // One question ask is one terminal dialog, however many questions it holds;
  // header/question/options/multiSelect are carried alongside as mirrors of
  // questions[0] for the card's summary line.
  asks: [],
  usage: null,          // latest claude.usage.update payload
  daemonConnected: true,
  selectedIndex: 0,     // session grid cursor
  queueIndex: 0,        // queue list cursor
  queueAnswering: false, // question hero's option list is open in place
  queueChoice: 0,        // cursor within that list
  // A question ask can hold several questions — one terminal dialog, walked
  // here one question at a time. Nothing is sent until the review step's
  // SUBMIT, so every answer stays editable until then.
  queueQIndex: 0,        // which question of the ask is open
  queueAnswers: [],      // number[][] — option indices picked, per question
  queueReview: false,    // the review + SUBMIT step is showing
  queueFromReview: false, // this question was opened from review — an edit, so
                          // answering it returns there rather than walking on
  armed: null,          // {id, expires} — destructive ask half-pressed
  undo: null,           // {ask, index, choice, expires} — answer held, undoable
  sending: null,        // {id, kind} — answer on the wire, daemon typing it
  btDevices: [],        // [{address, name, paired, connected}]
  btDiscoverable: false,
  btIndex: 0,           // bluetooth cursor: 0 = pairing toggle, 1..n = devices
  btMenu: null,         // address of the device whose action submenu is open
  btMenuIndex: 0,       // cursor within that submenu
  btBusy: null,         // address with an in-flight connect/disconnect
  btPairing: null,      // {address, name, pin} while a phone is pairing
  mascotOn: true,       // clock-screen sprite; tap the clock to toggle
};

var subs = [];

// The in-progress answer, wound back to nothing. Every path that changes which
// ask the hero is showing goes through this: a half-walked set of answers must
// never survive onto a different ask, where its indices mean other options.
export function closedAnswer() {
  return {
    queueAnswering: false, queueChoice: 0, queueQIndex: 0, queueAnswers: [],
    queueReview: false, queueFromReview: false,
  };
}

function withClosedAnswer(fields) {
  var out = closedAnswer();
  for (var k in fields) out[k] = fields[k];
  return out;
}

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

// The daemon's list of what is still waiting, made authoritative. Adding alone
// was not enough: an ask the daemon forgot — because it restarted, or resolved
// one while this screen was disconnected — had nothing left that could ever
// resolve it, so the card sat in the queue forever and answering it could only
// ever fail. Anything the daemon no longer vouches for goes.
//
// Locally expired cards are the exception: they are notices about prompts that
// moved to the terminal, the daemon never lists them, and sweepExpired ages
// them out on its own schedule.
export function reconcileAsks(list) {
  var live = {};
  for (var i = 0; i < list.length; i++) live[list[i].id] = true;
  var next = [];
  for (var j = 0; j < state.asks.length; j++) {
    var a = state.asks[j];
    if (live[a.id] || a.expired) next.push(a);
  }
  var known = {};
  for (var k = 0; k < next.length; k++) known[next[k].id] = true;
  for (var n = 0; n < list.length; n++) {
    if (known[list[n].id]) continue;
    // An answer held in its undo window is off the list on purpose; the daemon
    // still vouches for it because the decision hasn't been sent yet, and
    // re-adding it here would put the card back while its answer is in flight.
    if (state.undo && state.undo.ask.id === list[n].id) continue;
    var ask = list[n];
    if (!ask.sessionName) ask.sessionName = sessionName(ask.sessionId);
    next.push(ask);
  }
  if (next.length === state.asks.length) {
    var same = true;
    for (var s = 0; s < next.length; s++) if (next[s] !== state.asks[s]) same = false;
    if (same) return next.length;
  }
  var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
  update(withClosedAnswer({ asks: next, queueIndex: qi }));
  return next.length;
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
    update(withClosedAnswer({ asks: next, queueIndex: qi }));
  }
}

export function resolveAsk(id) {
  var next = [];
  for (var i = 0; i < state.asks.length; i++) {
    if (state.asks[i].id !== id) next.push(state.asks[i]);
  }
  var qi = Math.min(state.queueIndex, Math.max(0, next.length - 1));
  var fields = withClosedAnswer({ asks: next, queueIndex: qi });
  if (state.armed && state.armed.id === id) fields.armed = null;
  update(fields);
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
