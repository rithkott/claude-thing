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
import { isDestructive } from './screens/helpers.js';

var app = document.getElementById('app');
var banner = document.getElementById('banner');
var toastEl = document.getElementById('toast');
var edgeEl = document.getElementById('edge');

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
  // leaving the queue closes any open option list
  if (route().name !== 'queue' && store.get().queueAnswering) {
    store.update({ queueAnswering: false, queueChoice: 0 });
  }
  render();
});
store.subscribe(scheduleRender);
var EXPIRED_ASK_TTL_MS = 5 * 60 * 1000;
setInterval(function () {
  store.sweepExpired(EXPIRED_ASK_TTL_MS);
  var r = route();
  // clock ticks and queue wait ages
  if (r.name === 'ambient' || r.name === 'list' || r.name === 'queue') render();
}, 15000);

// ---- the device stays put ---------------------------------------------------
// It sits in peripheral vision, but the screen you left it on is the screen you
// come back to: nothing navigates on its own timer. surface() below is the one
// exception — it wakes the device to the queue when the daemon needs a person.

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

// ---- toast ---------------------------------------------------------------

var toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.className = 'toast show';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2500);
}

// ---- input ----------------------------------------------------------------

function askOptionCount(ask) {
  return ask.kind === 'question' ? (ask.options || []).length : 3;
}

onAction('dial', function (dir) {
  var state = store.get();
  var r = route();
  if (r.name === 'ask') {
    var ask = store.getAsk(r.arg);
    if (!ask) return;
    var max = askOptionCount(ask) - 1;
    askChoice = Math.max(0, Math.min(max, askChoice + dir));
    render();
  } else if (r.name === 'queue') {
    var n = state.asks.length;
    if (!n) return;
    if (state.queueAnswering) {
      // the option list is open: the dial moves within it, not the queue
      var hero = state.asks[Math.min(state.queueIndex, n - 1)];
      var omax = ((hero && hero.options) || []).length - 1;
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
    if (a.expired) openAsk(a.id);
    else if (a.kind === 'permission') allowHero(a);
    else if (!state.queueAnswering) store.update({ queueAnswering: true, queueChoice: 0 });
    else answerFromQueue(a, state.queueChoice);
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
  // Back closes the open option list first and returns to queue browsing;
  // a second back leaves for sessions.
  else if (r.name === 'queue' && store.get().queueAnswering) {
    store.update({ queueAnswering: false, queueChoice: 0 });
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
    if (hero.kind === 'question' && !hero.expired) {
      store.update({ queueAnswering: true, queueChoice: 0 });
    } else openAsk(hero.id);
  }
  else if (t.action === 'queue-choice' && hero) answerFromQueue(hero, Number(t.id));
  // stack rows promote to hero rather than opening the prompt
  else if (t.action === 'queue-promote' && t.id) {
    store.update({ queueIndex: indexOfAsk(t.id), queueAnswering: false, queueChoice: 0 });
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
    var option = (ask.options || [])[choice];
    if (!option) return;
    ws.request('claude.question.answer', { id: ask.id, optionIndex: choice })
      .then(function (res) {
        toast(questionToast(res, choice));
        // The daemon has no such ask — answered elsewhere, or restarted out
        // from under this card. Either way it is not ours to press again.
        // Only tidy up if the card is still showing (prompt-screen path).
        if (/already resolved/i.test(String(res.reason || '')) && store.getAsk(ask.id)) {
          store.resolveAsk(ask.id);
          nextAskOrBack();
        }
      })
      .catch(function () { toast('SEND FAILED'); });
    return;
  }
  var decision = choice === 0 ? 'allow' : 'deny';
  ws.request('claude.permission.answer', { requestId: ask.id, decision: decision })
    .then(function (res) {
      if (!res.accepted) toast('ALREADY ANSWERED');
    })
    .catch(function () { toast('SEND FAILED'); });
}

// Prompt-screen answer: immediate send. The destructive two-press contract
// still applies — the first press on ALLOW only arms it.
function answerAsk(id, choice) {
  var ask = store.getAsk(id);
  if (!ask) return;
  // An expired permission is unrecoverable — the hook already answered "ask"
  // and closed, so a decision now has nowhere to go. An expired *question* is
  // the opposite: it timed out here but is still up in the terminal, and the
  // daemon can still raise that window. So only permissions are dismissed.
  if (ask.expired && ask.kind !== 'question') return skipAsk(id);

  if (ask.kind === 'question') return sendAnswer(ask, choice);

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

// Answering from the queue must leave you on the queue with the next ask
// promoted into the hero — not fling you into the next item's prompt screen.
// returnTo is what nextAskOrBack() checks to suppress that jump.
//
// The answer itself is held for UNDO_MS before it is sent, so back can take
// it back: the card leaves the list at once (the next ask promotes), the
// toast says the answer is undoable, and only when the window closes does the
// decision actually go to the daemon.
var undoTimer = null;

function answerFromQueue(ask, choice) {
  returnTo = '#/queue';
  flushUndo();   // at most one answer in flight; an older one goes out now
  var index = indexOfAsk(ask.id);
  store.resolveAsk(ask.id);
  undoTimer = setTimeout(flushUndo, UNDO_MS);
  store.update({
    undo: { ask: ask, index: index, choice: choice, expires: Date.now() + UNDO_MS },
    armed: null,
    queueAnswering: false,
    queueChoice: 0,
  });
  var verb = ask.kind === 'question' ? 'ANSWERED' : choice === 0 ? 'ALLOW' : 'DENY';
  toast(verb + ' · BACK TO UNDO');
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
  store.update({ asks: asks, undo: null, queueIndex: at, queueAnswering: false, queueChoice: 0 });
  toast('RESTORED');
  nav('#/queue');
  return true;
}

// A question can only be answered by typing into its terminal, so say exactly
// how far we got: typed it, focused the window for you, or neither and why.
function questionToast(res, choice) {
  if (res.viaKeyboard) return 'ANSWERED ON MAC';
  var why = String(res.reason || '');
  if (res.focused) return 'FOCUSED — PRESS ' + (choice + 1) + ' ON MAC';
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
  });
});

ws.on('claude.question.request', function (q) {
  surface({
    kind: 'question',
    id: q.id,
    sessionId: q.sessionId,
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
ws.on('claude.queue.sync', function (d) { store.reconcileAsks((d && d.asks) || []); });

ws.on('claude.permission.resolved', function (p) { onResolved(p.requestId, p.resolution); });
ws.on('claude.question.resolved', function (q) { onResolved(q.id, q.resolution); });

ws.on('claude.daemon.status', function (s) {
  var was = store.get().daemonConnected;
  store.update({ daemonConnected: !!s.connected });
  // The socket to the connector survives a daemon restart, so this is the only
  // signal that the queue on the other side is a new one. Re-sync, or the asks
  // from before the restart stay on screen with nothing able to resolve them.
  if (!was && s.connected) syncQueue(false);
});

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

ws.onOpen(function () {
  ws.request('claude.sessions.list', {}).then(function (snap) {
    store.update({ daemonConnected: true });
    store.applySnapshot(snap);
  }).catch(function () {
    store.update({ daemonConnected: false });
  });

  syncQueue(true);

  ws.request('claude.usage.get', {}).then(function (u) {
    store.update({ usage: u });
  }).catch(function () {});
});

render();
