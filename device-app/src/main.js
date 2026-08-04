import './styles.css';
import * as ws from './ws.js';
import * as store from './store.js';
import { onAction } from './input.js';
import { renderList } from './screens/session-list.js';
import { renderDetail } from './screens/session-detail.js';
import { renderQueue } from './screens/queue.js';
import { renderAsk, setQueueContext } from './screens/ask.js';
import { renderUsage } from './screens/usage.js';
import { renderAmbient } from './screens/ambient.js';
import * as mascot from './mascot.js';
import { renderBluetooth, btMenuActions, renderBtPairing } from './screens/bluetooth.js';
import { isDestructive, watchTarget } from './screens/helpers.js';
import {
  questionsOf, currentQuestion, rowCount, startWalk, pressOptionAt, pressReviewAt, backStepAt,
} from './answering.js';
import { inflight } from './inflight.js';
import { createLink } from './link.js';

var app = document.getElementById('app');
var banner = document.getElementById('banner');
var toastEl = document.getElementById('toast');
var edgeEl = document.getElementById('edge');
var pendingEl = document.getElementById('pending');

// The device arms a destructive allow for ARM_MS, and holds every queue answer
// UNDO_MS before it is actually sent so back can take it back.
var ARM_MS = 4000;
var UNDO_MS = 6000;

// ---- routing (hash-based; ServeDir fallback makes path routing impossible) --

function route() {
  var h = window.location.hash || '#/list';
  var parts = h.slice(2).split('/');
  return { name: parts[0] || 'list', arg: parts[1] || null };
}

function nav(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else render();
}

var returnTo = '#/list';   // where to go after an ask resolves
var askChoice = 0;         // cursor within the current ask

var lastHtml = '';

function render() {
  var state = store.get();
  var r = route();
  var html;
  var isList = false;

  if (r.name === 'ambient') {
    html = renderAmbient(state);
    if (state.mascotOn) mascot.show();
  } else if (r.name === 'session' && r.arg) {
    html = renderDetail(state, r.arg);
  } else if (r.name === 'queue') {
    html = renderQueue(state);
  } else if (r.name === 'usage') {
    html = renderUsage(state);
  } else if (r.name === 'bt') {
    html = renderBluetooth(state);
  } else if (r.name === 'ask' && r.arg) {
    var ask = store.getAsk(r.arg);
    if (!ask) return nav(returnTo);
    // The prompt screen answers permissions. A question is walked in the queue
    // hero — it can hold several questions and a review step, and that walk
    // lives in one place rather than two.
    if (ask.kind === 'question') {
      store.update({ queueIndex: indexOfAsk(r.arg) });
      return nav('#/queue');
    }
    setQueueContext(indexOfAsk(r.arg), state.asks.length);
    html = renderQueue(state) + renderAsk(state, ask, askChoice);
  } else {
    html = renderList(state);
    isList = true;
  }
  if (r.name !== 'ambient' || !state.mascotOn) mascot.hide();
  // pairing is a device-wide event, not a screen: show it wherever you are
  if (state.btPairing) html += renderBtPairing(state.btPairing);

  // Only touch the DOM when the markup actually changed. On this CPU an
  // innerHTML swap costs milliseconds of parse + relayout and restarts every
  // CSS animation on screen (sprites, lamps, marquees) — so a no-op rebuild
  // landing on each daemon event is exactly the stutter it looks like.
  if (html !== lastHtml) {
    lastHtml = html;
    app.innerHTML = html;
    if (isList) marquee();
  }
  paintPending(state);
  banner.className = state.daemonConnected ? 'banner' : 'banner show';
  // A blocked session is visible from every screen: the panel edge pulses warn
  // whenever anything waits. Suppressed on the queue and the prompt, where you
  // are already looking at it.
  var blocked = state.asks.length > 0 && r.name !== 'queue' && r.name !== 'ask';
  edgeEl.className = blocked ? 'edge show' : 'edge';
}

// Store writes arrive in bursts — one daemon event can land several updates,
// and several sessions can update inside one frame. Painting more than once
// per frame is wasted work the panel can't even show, so renders triggered by
// data coalesce on requestAnimationFrame. Input handlers still call render()
// directly for same-tick feedback.
var renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function () {
    renderQueued = false;
    render();
  });
}

// Session names are measured against their tile after paint, so only the ones
// that genuinely overflow scroll. Guessing from character count would either
// animate names that fit or leave long ones clipped, and at 39px the line
// between the two moves with every name.
function marquee() {
  var names = app.querySelectorAll('[data-marquee]');
  // All reads, then all writes: interleaving them forces a full relayout per
  // tile (write invalidates, next read re-measures), which on this CPU turns
  // one render into a dozen synchronous layouts.
  var overflows = [];
  for (var i = 0; i < names.length; i++) {
    overflows.push(names[i].scrollWidth - names[i].parentNode.clientWidth);
  }
  for (var k = 0; k < names.length; k++) {
    var over = overflows[k];
    if (over <= 2) continue;
    var el = names[k];
    // Long names get proportionally longer to read, with a dwell at each end.
    var ms = 7000 + Math.round(over * 26);
    el.style.animation = 'marquee' + ' ' + ms + 'ms linear infinite';
    el.style.setProperty('--shift', '-' + over + 'px');
    // Compositor layers are scarce on this GPU, so only names that actually
    // scroll get promoted (the CSS deliberately has no blanket will-change).
    el.style.willChange = 'transform';
  }
}

function indexOfAsk(id) {
  var asks = store.get().asks;
  for (var i = 0; i < asks.length; i++) if (asks[i].id === id) return i;
  return 0;
}

window.addEventListener('hashchange', function () {
  askChoice = 0;
  // leaving the queue abandons a half-walked answer — nothing was sent
  if (route().name !== 'queue' && store.get().queueAnswering) {
    store.update(store.closedAnswer());
  }
  render();
  armQueueIdleExit();
  scheduleWatch();
});
store.subscribe(scheduleRender);
store.subscribe(armQueueIdleExit);

// ---- watched-session details ------------------------------------------------
// The daemon broadcasts every session's detail stream; this screen reads one —
// the open detail page's, or the grid cursor's. Telling the daemon which
// (claude.session.watch) lets it keep the rest off the Bluetooth link. Trailing
// debounce: the dial sweeps several tiles a second and each watch is a relay
// round trip, so the target is read once the cursor settles. On a daemon too
// old to know the method, one failed call latches the whole feature off.
var WATCH_DEBOUNCE_MS = 250;
var watchTimer = null;
var sentWatch;              // last id sent; undefined = never sent
var watchSupported = true;

function scheduleWatch(force) {
  if (!watchSupported) return;
  if (force === true) sentWatch = undefined;
  if (watchTimer) return;
  watchTimer = setTimeout(function () {
    watchTimer = null;
    var r = route();
    var target = watchTarget(r.name, r.arg, store.get());
    if (target === sentWatch) return;
    sentWatch = target;
    ws.request('claude.session.watch', { id: target }).catch(function (e) {
      if (/Unknown method/i.test(String(e && e.message))) watchSupported = false;
      sentWatch = undefined;   // otherwise transient — retry on the next trigger
    });
    // The filter means this session's detail may not have flowed while it was
    // unwatched; fetch once so the subline is fresh when the cursor lands.
    if (target) {
      ws.request('claude.session.get', { id: target }).then(function (d) {
        store.applyDetail(d);
      }).catch(function () {});
    }
  }, WATCH_DEBOUNCE_MS);
}

store.subscribe(function () { scheduleWatch(); });
var EXPIRED_ASK_TTL_MS = 5 * 60 * 1000;
setInterval(function () {
  store.sweepExpired(EXPIRED_ASK_TTL_MS);
  var r = route();
  // clock ticks and queue wait ages
  if (r.name === 'ambient' || r.name === 'list' || r.name === 'queue') render();
}, 15000);

// ---- the device stays put ---------------------------------------------------
// It sits in peripheral vision, but the screen you left it on is the screen you
// come back to: no page drifts on its own timer. Two exceptions, both about the
// queue and nothing else: surface() below wakes the device to the queue when the
// daemon needs a person, and an empty queue hands the screen back below.

// An empty queue is a dead end — it says NOTHING WAITING ON YOU and there is no
// press that does anything. Left on it, the device shows nothing for however
// long it sits there, so a minute after the last ask clears it falls back to the
// sessions list, which at least keeps working. The clock, usage and every other
// page are untouched: the timer only ever runs while the queue is on screen and
// empty, and any ask arriving cancels it.
var QUEUE_IDLE_EXIT_MS = 60000;
var queueIdleTimer = null;

function armQueueIdleExit() {
  var idle = route().name === 'queue' && !store.get().asks.length;
  if (!idle) {
    if (queueIdleTimer) { clearTimeout(queueIdleTimer); queueIdleTimer = null; }
    return;
  }
  // Already counting down — a store write that leaves the queue empty (a
  // session update, a usage tick) must not restart the minute.
  if (queueIdleTimer) return;
  queueIdleTimer = setTimeout(function () {
    queueIdleTimer = null;
    // Re-checked because the state can have moved under the timer. An answer
    // still held for undo, or still being typed on the Mac, has an indicator
    // running on this screen — that is not a queue that is done with you.
    var st = store.get();
    if (route().name !== 'queue' || st.asks.length || inflight(st, UNDO_MS)) {
      return armQueueIdleExit();
    }
    returnTo = '#/list';
    nav('#/list');
  }, QUEUE_IDLE_EXIT_MS);
}

// The prompt screen acts against a live deadline, so its countdown must tick
// on its own clock. It used to ride the daemon's event stream — which now goes
// quiet when nothing changes, exactly when a lone pending ask would sit
// frozen at "45s left" until the 30s heartbeat. The same tick ages out an
// armed destructive allow.
setInterval(function () {
  var nowMs = Date.now();
  var st = store.get();
  if (st.armed && nowMs > st.armed.expires) store.update({ armed: null });
  if (route().name === 'ask') render();
}, 1000);

// ---- mascot toggle ---------------------------------------------------------
// The sprite is decoration, and some people want a clock to be a clock. A tap
// anywhere on the ambient screen flips him on or off, and the choice survives
// a reboot. localStorage failures (private mode, a full disk) cost only the
// persistence, never the toggle.

var MASCOT_KEY = 'mascotOff';
try {
  if (window.localStorage.getItem(MASCOT_KEY)) store.update({ mascotOn: false });
} catch (e) {}

function toggleMascot() {
  var on = !store.get().mascotOn;
  store.update({ mascotOn: on });
  try {
    if (on) window.localStorage.removeItem(MASCOT_KEY);
    else window.localStorage.setItem(MASCOT_KEY, '1');
  } catch (e) {}
  toast(on ? 'SPRITE ON' : 'SPRITE OFF');
}

// ---- the answer in flight --------------------------------------------------
//
// From the press to the keystrokes landing is seconds — the undo window, then
// the daemon focusing the terminal and typing the sequence out. The indicator
// stands for that whole wait, so a screen that has already dropped the card
// still says the answer is on its way rather than looking finished.
//
// Written only when the phase actually changes: the drain ring is a CSS
// animation, and rewriting the class on every daemon event would restart it.

var lastPending = '';
function paintPending(state) {
  var v = inflight(state, UNDO_MS);
  var key = v ? v.phase + '|' + v.label : '';
  if (key === lastPending) return;
  lastPending = key;
  if (!v) {
    pendingEl.className = 'pending';
    return;
  }
  pendingEl.querySelector('.pendlabel').textContent = v.label;
  // The undo ring is a countdown, so it runs for exactly as long as the window
  // it is counting down — one number, kept in one place.
  if (v.ms) pendingEl.querySelector('.pendarc').style.animationDuration = v.ms + 'ms';
  pendingEl.className = 'pending show ' + v.phase;
}

// ---- toast ---------------------------------------------------------------

var toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.className = 'toast show';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2500);
}

// ---- input ----------------------------------------------------------------

// The prompt screen is permissions only now — allow, deny, skip.
function askOptionCount() {
  return 3;
}

onAction('dial', function (dir) {
  var state = store.get();
  var r = route();
  if (r.name === 'ask') {
    var ask = store.getAsk(r.arg);
    if (!ask) return;
    var max = askOptionCount() - 1;
    askChoice = Math.max(0, Math.min(max, askChoice + dir));
    render();
  } else if (r.name === 'queue') {
    var n = state.asks.length;
    if (!n) return;
    if (state.queueAnswering) {
      // A step of the walk is open: the dial moves within its rows, not the
      // queue. The row count comes from the same model the screen drew from,
      // so the cursor can never run past what is on screen.
      var hero = state.asks[Math.min(state.queueIndex, n - 1)];
      var omax = rowCount(hero, state) - 1;
      store.update({ queueChoice: Math.max(0, Math.min(omax, state.queueChoice + dir)) });
    } else {
      store.update({ queueIndex: Math.max(0, Math.min(n - 1, state.queueIndex + dir)) });
    }
  } else if (r.name === 'list') {
    var m = state.sessions.length;
    if (m) store.update({ selectedIndex: Math.max(0, Math.min(m - 1, state.selectedIndex + dir)) });
  } else if (r.name === 'bt') {
    if (state.btMenu) {
      var dev = btDevice(state.btMenu);
      var mmax = (dev ? btMenuActions(dev).length : 1) - 1;
      store.update({ btMenuIndex: Math.max(0, Math.min(mmax, state.btMenuIndex + dir)) });
    } else {
      store.update({ btIndex: Math.max(0, Math.min(state.btDevices.length, state.btIndex + dir)) });
    }
  } else if (r.name === 'ambient') {
    nav('#/list');
  }
});

onAction('select', function () {
  var state = store.get();
  var r = route();
  if (r.name === 'ask') {
    answerAsk(r.arg, askChoice);
  } else if (r.name === 'queue') {
    // Triage without leaving the queue: a permission is allowed in place
    // because allow/deny is the whole decision, and a question opens its
    // option list inside the hero — first press opens, second answers.
    var a = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
    if (!a) return;
    if (a.kind === 'permission') {
      if (a.expired) openAsk(a.id);
      else allowHero(a);
    }
    else if (!state.queueAnswering) openAnswering(a);
    else if (state.queueReview) pressReview(a, state.queueChoice);
    else pressOption(a, state.queueChoice);
  } else if (r.name === 'list') {
    var s = state.sessions[state.selectedIndex];
    if (s) openSession(s.id);
  } else if (r.name === 'bt') {
    if (state.btMenu) {
      var dev = btDevice(state.btMenu);
      if (dev) btAct(dev, btMenuActions(dev)[state.btMenuIndex]);
      else store.update({ btMenu: null });
    } else if (state.btIndex === 0) {
      toggleDiscoverable();
    } else {
      var target = state.btDevices[state.btIndex - 1];
      if (target) store.update({ btMenu: target.address, btMenuIndex: 0 });
    }
  } else if (r.name === 'ambient') {
    // When blocked, the press goes where the work is; the session list is the
    // manual route.
    nav(state.asks.length ? '#/queue' : '#/list');
  }
});

onAction('back', function () {
  var r = route();
  // pairing overlay sits on top of everything, so back peels it off first
  if (store.get().btPairing) return store.update({ btPairing: null });
  // Back inside the undo window takes the answer back: the ask returns to its
  // place in the queue and nothing was ever sent.
  if (restoreUndo()) return;
  if (r.name === 'ask') skipAsk(r.arg);
  else if (r.name === 'session') nav('#/list');
  // Back walks the open ask backwards — review to the last question, question
  // to the one before it, answers intact. From the first question it closes
  // the list and returns to queue browsing; a second back leaves for sessions.
  else if (r.name === 'queue' && store.get().queueAnswering) {
    var st = store.get();
    var open = st.asks[Math.min(st.queueIndex, st.asks.length - 1)];
    if (!backStep(open)) store.update(store.closedAnswer());
  }
  else if (r.name === 'queue' || r.name === 'usage') nav('#/list');
  else if (r.name === 'bt') {
    if (store.get().btMenu) store.update({ btMenu: null });
    else nav(btReturnTo);
  }
  else if (r.name === 'list') nav('#/ambient');
  else nav('#/list');
});

onAction('page-sessions', function () { nav('#/list'); });
onAction('page-queue', function () { nav('#/queue'); });
onAction('page-usage', function () { nav('#/usage'); });

// Preset 4 denies whatever is in front of you — the prompt screen's ask, or
// the queue's hero.
onAction('deny', function () {
  var r = route();
  if (r.name === 'ask') {
    var ask = store.getAsk(r.arg);
    if (ask && ask.kind === 'permission') answerAsk(r.arg, 1);   // 1 = deny
    return;
  }
  if (r.name === 'queue') {
    var state = store.get();
    var hero = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
    if (!hero) return;
    // On a multiSelect question the dial press toggles, so nothing under the
    // cursor ever moves you on — the DONE row does, and hunting for it is how
    // the walk felt stuck. Preset 4 is the device's one context action and is
    // otherwise idle during a question, so here it means "done picking".
    if (state.queueAnswering && !state.queueReview && hero.kind === 'question') {
      var q = currentQuestion(hero, state);
      if (q && q.multiSelect) return pressOption(hero, q.options.length);
      return;
    }
    // An expired ask was answered in the terminal; deny is how the dead slot
    // is dismissed without pretending an answer went anywhere.
    if (hero.expired) {
      store.resolveAsk(hero.id);
      toast('DISMISSED');
      return;
    }
    if (hero.kind === 'permission') answerFromQueue(hero, 1);
  }
});

onAction('ambient', function () {
  nav(route().name === 'ambient' ? '#/list' : '#/ambient');
});

// ---- bluetooth --------------------------------------------------------------

var btReturnTo = '#/list';   // where hold-m was pressed, restored on back

onAction('bt-manage', function () {
  if (route().name === 'bt') return nav(btReturnTo);
  btReturnTo = window.location.hash || '#/list';
  store.update({ btIndex: 0, btMenu: null, btMenuIndex: 0 });
  nav('#/bt');
  refreshBtDevices();
});

// One fetch on open, one per pairing change — never on a timer. The daemon's
// watchdog misreads a polled bluetooth.devices.list as a stuck session.
function refreshBtDevices() {
  ws.request('bluetooth.devices.list').then(function (d) {
    store.update({ btDevices: (d && d.devices) || [] });
  }).catch(function () {});
}

function btDevice(address) {
  var devices = store.get().btDevices;
  for (var i = 0; i < devices.length; i++) {
    if (devices[i].address === address) return devices[i];
  }
  return null;
}

function btDeviceIndex(address) {
  var devices = store.get().btDevices;
  for (var i = 0; i < devices.length; i++) {
    if (devices[i].address === address) return i;
  }
  return -1;
}

function toggleDiscoverable() {
  var want = !store.get().btDiscoverable;
  ws.request('bluetooth.discoverable', { discoverable: want }).then(function (res) {
    if (res && res.status === 'requested') {
      // optimistic — the bluetooth.discoverable event confirms or corrects
      store.update({ btDiscoverable: want });
      toast(want ? 'PAIRING MODE ON' : 'PAIRING MODE OFF');
    }
  }).catch(function () { toast('FAILED'); });
}

// BT connects regularly outrun the 10s default request timeout, hence 30s.
var BT_CONNECT_TIMEOUT_MS = 30000;

function btAct(device, action) {
  var addr = device.address;
  store.update({ btMenu: null, btMenuIndex: 0 });
  if (action === 'CANCEL' || !action) return;

  if (action === 'CONNECT') {
    store.update({ btBusy: addr });
    ws.request('bluetooth.device.connect', { address: addr }, BT_CONNECT_TIMEOUT_MS)
      .then(function (res) {
        store.update({ btBusy: null });
        var status = res && res.status;
        if (status === 'connected') toast('CONNECTED');
        else if (status === 'waiting_for_macos_connector' || status === 'waiting_for_android') toast('WAITING FOR PHONE');
        else toast('CONNECT SENT');
      })
      .catch(function () { store.update({ btBusy: null }); toast('CONNECT FAILED'); });
    return;
  }

  if (action === 'DISCONNECT') {
    store.update({ btBusy: addr });
    ws.request('bluetooth.device.disconnect', { address: addr }, BT_CONNECT_TIMEOUT_MS)
      .then(function () { store.update({ btBusy: null }); toast('DISCONNECTED'); })
      .catch(function () { store.update({ btBusy: null }); toast('FAILED'); });
    return;
  }

  if (action === 'FORGET') {
    ws.request('bluetooth.device.forget', { address: addr })
      .then(function () {
        var next = [];
        var devices = store.get().btDevices;
        for (var i = 0; i < devices.length; i++) {
          if (devices[i].address !== addr) next.push(devices[i]);
        }
        store.update({ btDevices: next, btIndex: Math.min(store.get().btIndex, next.length) });
        toast('FORGOTTEN');
      })
      .catch(function () { toast('FAILED'); });
  }
}

onAction('tap', function (t) {
  var state = store.get();
  var hero = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
  if (t.action === 'open' && t.id) openSession(t.id);
  else if (t.action === 'open-ask' && t.id) openAsk(t.id);
  else if (t.action === 'ask-choice') answerAsk(route().arg, Number(t.id));
  else if (t.action === 'ask-skip') skipAsk(route().arg);
  else if (t.action === 'queue-allow' && hero) allowHero(hero);
  else if (t.action === 'queue-deny' && hero) answerFromQueue(hero, 1);
  // a question opens its option list inside the hero, not the prompt screen
  else if (t.action === 'queue-answer' && hero) {
    if (hero.kind === 'question') openAnswering(hero);
    else openAsk(hero.id);
  }
  else if (t.action === 'queue-choice' && hero) pressOption(hero, Number(t.id));
  else if (t.action === 'queue-review' && hero) pressReview(hero, Number(t.id));
  // stack rows promote to hero rather than opening the prompt
  else if (t.action === 'queue-promote' && t.id) {
    var promoted = store.closedAnswer();
    promoted.queueIndex = indexOfAsk(t.id);
    store.update(promoted);
  }
  else if (t.action === 'mascot-toggle') toggleMascot();
  else if (t.action === 'bt-toggle') toggleDiscoverable();
  else if (t.action === 'bt-device' && t.id) {
    var idx = btDeviceIndex(t.id);
    store.update({ btMenu: t.id, btMenuIndex: 0, btIndex: idx >= 0 ? idx + 1 : state.btIndex });
  } else if (t.action === 'bt-menu-act' && state.btMenu) {
    var dev = btDevice(state.btMenu);
    if (dev) btAct(dev, btMenuActions(dev)[Number(t.id)]);
    else store.update({ btMenu: null });
  }
});

// ---- actions ---------------------------------------------------------------

function openSession(id) {
  nav('#/session/' + id);
  ws.request('claude.session.get', { id: id }).then(function (d) {
    store.applyDetail(d);
  }).catch(function () {});
  // bring that session's terminal window to the front on the Mac, as if the
  // user had clicked it
  ws.request('claude.session.focus', { id: id }).catch(function () {});
}

function openAsk(id) {
  returnTo = '#/queue';
  askChoice = 0;
  nav('#/ask/' + id);
}

// The wire send, taking the ask itself: by the time a held queue answer goes
// out, the card is already off the local list, so a lookup by id would fail.
function sendAnswer(ask, choice) {
  if (ask.kind === 'question') {
    // choice is number[][] — one entry per question of the ask, each the option
    // indices picked for it. The daemon turns the whole set into one keystroke
    // sequence, ending with the Return that presses "Submit answers".
    var answers = choice;
    if (!answers || !answers.length) return;
    markSending(ask);
    ws.request('claude.question.answer', { id: ask.id, answers: answers })
      .then(function (res) {
        clearSending(ask.id);
        toast(questionToast(ask, res, answers));
        // The daemon has no such ask — answered elsewhere, or restarted out
        // from under this card. Either way it is not ours to press again.
        // Only tidy up if the card is still showing (prompt-screen path).
        if (/already resolved/i.test(String(res.reason || '')) && store.getAsk(ask.id)) {
          store.resolveAsk(ask.id);
          nextAskOrBack();
        }
      })
      .catch(function () { clearSending(ask.id); toast('SEND FAILED'); });
    return;
  }
  var decision = choice === 0 ? 'allow' : 'deny';
  markSending(ask);
  ws.request('claude.permission.answer', { requestId: ask.id, decision: decision })
    .then(function (res) {
      clearSending(ask.id);
      if (!res.accepted) toast('ALREADY ANSWERED');
    })
    .catch(function () { clearSending(ask.id); toast('SEND FAILED'); });
}

function markSending(ask) {
  store.update({ sending: { id: ask.id, kind: ask.kind } });
}

// By id: an answer flushed early to make way for a newer one can land after
// that newer one went out, and clearing blind would drop the indicator while
// somebody's keystrokes are still being typed.
function clearSending(id) {
  var s = store.get().sending;
  if (s && s.id === id) store.update({ sending: null });
}

// Prompt-screen answer: immediate send. The destructive two-press contract
// still applies — the first press on ALLOW only arms it.
function answerAsk(id, choice) {
  var ask = store.getAsk(id);
  if (!ask) return;
  // Questions are walked in the queue hero; the render redirects them there,
  // so this screen only ever decides permissions.
  if (ask.kind === 'question') return nav('#/queue');
  // An expired permission is unrecoverable — the hook already answered "ask"
  // and closed, so a decision now has nowhere to go.
  if (ask.expired) return skipAsk(id);

  if (choice === 2) return skipAsk(id);
  if (choice === 0 && isDestructive(ask)) {
    var st = store.get();
    if (!(st.armed && st.armed.id === ask.id)) {
      return store.update({ armed: { id: ask.id, expires: Date.now() + ARM_MS } });
    }
    store.update({ armed: null });
  }
  sendAnswer(ask, choice);
}

// Allow from the queue hero. A destructive command arms on the first press —
// the chip fills danger and asks again — and only fires on the second.
function allowHero(hero) {
  var st = store.get();
  if (isDestructive(hero) && !(st.armed && st.armed.id === hero.id)) {
    store.update({ armed: { id: hero.id, expires: Date.now() + ARM_MS } });
    return;
  }
  answerFromQueue(hero, 0);
}

// ---- walking a question ask -------------------------------------------------
//
// A question ask is one terminal dialog and may hold several questions. They
// are walked here, on the device, and nothing goes to the Mac until SUBMIT —
// which is what makes every answer editable right up to the last press, and
// what lets the dialog's own "Submit answers" step be pressed at all.

// The transitions themselves are pure and live in answering.js; this applies
// their result — the fields to store, and the answers to send once the walk is
// over.
function applyStep(ask, step) {
  if (!step) return false;
  if (step.fields) store.update(step.fields);
  if (step.incomplete) toast('ANSWER THIS ONE FIRST');
  if (step.submit) answerFromQueue(ask, step.submit);
  return true;
}

function openAnswering(ask) { applyStep(ask, startWalk(ask)); }
function pressOption(ask, row) { applyStep(ask, pressOptionAt(ask, store.get(), row)); }
function pressReview(ask, row) { applyStep(ask, pressReviewAt(ask, store.get(), row)); }
function backStep(ask) { return applyStep(ask, backStepAt(ask, store.get())); }

// Answering from the queue must leave you on the queue with the next ask
// promoted into the hero — not fling you into the next item's prompt screen.
// returnTo is what nextAskOrBack() checks to suppress that jump.
//
// The answer itself is held for UNDO_MS before it is sent, so back can take
// it back: the card leaves the list at once (the next ask promotes), the
// toast says the answer is undoable, and only when the window closes does the
// decision actually go to the daemon.
var undoTimer = null;

// choice is the whole decision: number[][] for a question (every question of
// the ask), 0/1 for a permission. It is held intact so undo restores the whole
// set, not a half-walked one.
function answerFromQueue(ask, choice) {
  returnTo = '#/queue';
  flushUndo();   // at most one answer in flight; an older one goes out now
  var index = indexOfAsk(ask.id);
  store.resolveAsk(ask.id);
  undoTimer = setTimeout(flushUndo, UNDO_MS);
  var fields = store.closedAnswer();
  fields.undo = { ask: ask, index: index, choice: choice, expires: Date.now() + UNDO_MS };
  fields.armed = null;
  store.update(fields);
  // No toast here: the in-flight indicator says the same thing and keeps saying
  // it for the whole wait, where a toast would have faded after 2.5s and left
  // the last four seconds of the undo window unannounced.
}

function clearUndo() {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  var u = store.get().undo;
  if (u) store.update({ undo: null });
  return u;
}

function flushUndo() {
  var u = clearUndo();
  if (u) sendAnswer(u.ask, u.choice);
}

// The daemon resolved the held ask itself — answered in the terminal, or the
// hook timed out. Nothing to send, nothing on screen to update.
function cancelUndo(id) {
  var u = store.get().undo;
  if (!u || u.ask.id !== id) return false;
  clearUndo();
  return true;
}

function restoreUndo() {
  var u = store.get().undo;
  if (!u) return false;
  clearUndo();
  var asks = store.get().asks.slice();
  var at = Math.min(u.index, asks.length);
  asks.splice(at, 0, u.ask);
  var fields = store.closedAnswer();
  fields.asks = asks;
  fields.undo = null;
  fields.queueIndex = at;
  store.update(fields);
  toast('RESTORED');
  nav('#/queue');
  return true;
}

// A question can only be answered by typing into its terminal, so say exactly
// how far we got: typed it, focused the window for you, or neither and why.
function questionToast(ask, res, answers) {
  if (res.viaKeyboard) return 'ANSWERED ON MAC';
  var why = String(res.reason || '');
  if (res.focused) {
    // Naming the key only helps when there is exactly one to press. A group,
    // or a multiSelect, is a sequence — telling someone to press "1" for it
    // would be telling them to answer it wrong.
    var q = questionsOf(ask);
    var single = q.length === 1 && !q[0].multiSelect;
    return single ? 'FOCUSED — PRESS ' + (answers[0][0] + 1) + ' ON MAC'
      : 'FOCUSED — ANSWER ON MAC';
  }
  // The card outlived the daemon's copy of the ask — answered on the Mac, or
  // the daemon restarted under it. Not a failure to answer, and not something
  // pressing again fixes: the terminal owns it now.
  if (/already resolved/i.test(why)) return 'GONE — ANSWER IN TERMINAL';
  if (/denied/i.test(why)) return 'ALLOW AUTOMATION IN MAC SETTINGS';
  if (/background agent/i.test(why)) return 'BACKGROUND AGENT — NO WINDOW';
  if (/registry|tty|no session|unknown session/i.test(why)) return 'NO TERMINAL WINDOW FOUND';
  return 'COULD NOT ANSWER';
}

function skipAsk(id) {
  store.resolveAsk(id);
  toast('LEFT FOR THE TERMINAL');
  nextAskOrBack();
}

function nextAskOrBack() {
  var asks = store.get().asks;
  if (asks.length && returnTo !== '#/queue') {
    askChoice = 0;
    // a question is answered on the queue, not the prompt screen
    if (asks[0].kind === 'question') {
      store.update({ queueIndex: 0 });
      nav('#/queue');
    } else {
      nav('#/ask/' + asks[0].id);
    }
  } else {
    nav(returnTo);
  }
}

// ---- daemon events ----------------------------------------------------------

ws.on('claude.sessions.update', function (snap) { store.applySnapshot(snap); });
ws.on('claude.session.update', function (d) { store.applyDetail(d); });
ws.on('claude.usage.update', function (u) { store.update({ usage: u }); });

// Every ask surfaces on the queue — the screen where everything is answerable
// in place. The device only moves itself when it was resting: from ambient it
// wakes straight to the queue with a NEEDS YOU toast. On any other screen the
// pulsing panel edge and the topbar count carry the alert without yanking the
// page out from under the user; the full-screen prompt is only ever entered
// deliberately.
function surface(ask) {
  store.pushAsk(ask);
  var r = route();
  if (r.name === 'ask') return render();   // don't yank a live prompt; the counter updates
  if (r.name === 'ambient') {
    store.update({ queueIndex: indexOfAsk(ask.id) });
    toast('NEEDS YOU');
    returnTo = '#/list';
    nav('#/queue');
    return;
  }
  if (r.name === 'queue') {
    var st = store.get();
    // A question promotes to hero, ready for a press — unless the user is
    // mid-answer on another one, in which case it queues up behind.
    if (ask.kind === 'question' && !st.queueAnswering) {
      store.update({ queueIndex: indexOfAsk(ask.id) });
    }
    return;
  }
  render();   // edge + topbar count
}

ws.on('claude.permission.request', function (p) {
  surface({
    kind: 'permission',
    id: p.requestId,
    sessionId: p.sessionId,
    tool: p.tool,
    summary: p.summary,
    intent: p.intent || '',
    createdTs: p.createdTs,
    timeoutMs: p.timeoutMs,
    destructive: p.destructive,
  });
});

ws.on('claude.question.request', function (q) {
  surface({
    kind: 'question',
    id: q.id,
    sessionId: q.sessionId,
    // One ask is one terminal dialog; questions holds every question in it.
    // The top-level fields mirror questions[0] and are what the card's summary
    // line reads — questionsOf() rebuilds the list from them if a daemon that
    // predates grouping is on the other end.
    questions: q.questions || null,
    header: q.header,
    question: q.question,
    intent: q.intent || '',
    options: q.options || [],
    multiSelect: !!q.multiSelect,
    createdTs: q.createdTs,
  });
});

function onResolved(id, resolution) {
  // An answer held in its undo window: the daemon beat us to it, so there is
  // nothing to send and nothing on screen to update.
  if (cancelUndo(id)) return;
  var r = route();
  var wasCurrent = r.name === 'ask' && r.arg === id;
  // A timeout is the one resolution nobody chose: the hook gave up and the
  // question is now sitting in a terminal. Keep it on screen saying so instead
  // of clearing it like an answered prompt.
  if (resolution === 'timeout' && store.expireAsk(id)) {
    if (wasCurrent) {
      toast('HOOK TIMED OUT — ANSWER IN TERMINAL');
      render();
    }
    return;
  }
  store.resolveAsk(id);
  if (wasCurrent) {
    toast(String(resolution).toUpperCase());
    nextAskOrBack();
  }
}

// The daemon's whole waiting list, pushed when any client connects. This is
// what clears cards left behind by a daemon that restarted: on hardware the
// device's own socket is to the connector and never dropped, so nothing else
// tells this screen the queue it is showing belongs to a dead process.
ws.on('claude.queue.sync', function (d) {
  store.reconcileAsks((d && d.asks) || []);
  // queue.sync fires on every client hello — on hardware, the one reliable
  // sign the daemon restarted (the device's own socket is to the connector and
  // never drops). A fresh daemon has no watch state; re-assert ours.
  scheduleWatch(true);
});

ws.on('claude.permission.resolved', function (p) { onResolved(p.requestId, p.resolution); });
ws.on('claude.question.resolved', function (q) { onResolved(q.id, q.resolution); });

// ---- is the daemon there? ---------------------------------------------------
// See link.js: the banner is driven by what the daemon has actually said
// lately, not by how the first request of the session happened to go.
var LINK_TICK_MS = 10000;

var link = createLink({
  ping: function () {
    return ws.request('claude.ping', {}).catch(function (e) {
      // A daemon too old to know the method still answered, which is the only
      // thing being asked. Every other failure is the link not delivering.
      if (/Unknown method/i.test(String(e && e.message))) return {};
      throw e;
    });
  },
  onChange: function (connected, was) {
    store.update({ daemonConnected: connected });
    // A daemon that just came back is a daemon that has forgotten the asks it
    // sent and the session it was told to watch — refill from the live one, or
    // the screen keeps showing cards nothing can resolve. Not on the first
    // answer of the session: boot has just done exactly this.
    if (connected && was === false) hydrate(false);
  },
});

ws.onTraffic(link.seen);
setInterval(function () { link.tick(); }, LINK_TICK_MS);

// Only the emulator's bridge sends this; hardware has no equivalent, which is
// why the link asks for itself rather than waiting to be told.
ws.on('claude.daemon.status', function (s) { link.report(!!s.connected); });

// ---- bluetooth events -------------------------------------------------------

ws.on('bluetooth.device', function (d) {
  if (!d || !d.device) return;
  var devices = store.get().btDevices;
  if (d.event === 'removed') {
    var next = [];
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].address !== d.device) next.push(devices[i]);
    }
    store.update({ btDevices: next, btIndex: Math.min(store.get().btIndex, next.length) });
    return;
  }
  if (d.event === 'connected' || d.event === 'disconnected') {
    for (var j = 0; j < devices.length; j++) {
      if (devices[j].address === d.device) {
        devices[j].connected = d.event === 'connected';
        store.update({});
        return;
      }
    }
  }
});

// `paired` carries a MAC, `pairing_succeeded` a dbus path — the formats don't
// match each other or our list keys, so refetch instead of string-matching.
ws.on('bluetooth.pairing', function (d) {
  d = d || {};
  if (d.event === 'paired' || d.type === 'pairing_succeeded') {
    store.update({ btPairing: null });
    toast('PAIRED');
    refreshBtDevices();
  } else if (d.event === 'unpaired') {
    refreshBtDevices();
  }
});

ws.on('bluetooth.agent', function (d) {
  d = d || {};
  if (d.type === 'bluetooth_pin') {
    store.update({ btPairing: { address: d.address, name: d.name, pin: d.pin } });
  } else if (d.event === 'cancel') {
    if (store.get().btPairing) toast('PAIRING CANCELLED');
    store.update({ btPairing: null });
  }
  // everything else (pin/passkey requests, authorization) is auto-handled
  // by the daemon's agent
});

// the daemon can time discoverable out on its own; keep the toggle honest
ws.on('bluetooth.discoverable', function (d) {
  store.update({ btDiscoverable: !!(d && d.discoverable) });
});

// ---- boot -------------------------------------------------------------------

// Take the daemon's word for what is still waiting. Called on connect and every
// time the daemon comes back, because a daemon that restarted has forgotten
// every ask it ever sent while this screen kept showing them.
function syncQueue(jumpIfIdle) {
  ws.request('claude.queue.list', {}).then(function (res) {
    var asks = res.asks || [];
    store.reconcileAsks(asks);
    // The queue is where everything is answerable in place, so that is where
    // a fresh connection with work waiting lands.
    if (jumpIfIdle && asks.length && route().name === 'list') {
      returnTo = '#/list';
      nav('#/queue');
    }
  }).catch(function () {});
}

// A synchronous response cannot span the Bluetooth relay's 2000-byte chunks,
// and a worst-case SessionSummary is ~355 bytes plus ~160 of envelope — so ask
// for four. The full grid follows as an async snapshot push, which chunks fine.
var BOOT_SESSION_LIMIT = 4;

// Everything this screen needs the daemon to tell it up front. Run at boot and
// again whenever the daemon comes back: a daemon that restarted has forgotten
// every ask it sent and every watch it was given, and a boot that happened
// while it was down got none of this at all.
function hydrate(jumpIfIdle) {
  ws.request('claude.sessions.list', { limit: BOOT_SESSION_LIMIT }).then(function (snap) {
    store.applySnapshot(snap);
  }).catch(function () {});

  syncQueue(jumpIfIdle);
  scheduleWatch(true);

  ws.request('claude.usage.get', { slim: 1 }).then(function (u) {
    store.update({ usage: u });
  }).catch(function () {});
}

ws.onOpen(function () {
  hydrate(true);
  link.tick();            // lastSeen is 0 at boot, so this asks outright
});

render();
armQueueIdleExit();   // booting straight onto an empty queue counts too
