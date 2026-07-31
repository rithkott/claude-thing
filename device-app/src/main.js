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

var app = document.getElementById('app');
var banner = document.getElementById('banner');
var toastEl = document.getElementById('toast');

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

function render() {
  var state = store.get();
  var r = route();

  if (r.name === 'ambient') {
    app.innerHTML = renderAmbient(state);
  } else if (r.name === 'session' && r.arg) {
    app.innerHTML = renderDetail(state, r.arg);
  } else if (r.name === 'queue') {
    app.innerHTML = renderQueue(state);
  } else if (r.name === 'usage') {
    app.innerHTML = renderUsage(state);
  } else if (r.name === 'ask' && r.arg) {
    var ask = store.getAsk(r.arg);
    if (!ask) return nav(returnTo);
    setQueueContext(indexOfAsk(r.arg), state.asks.length);
    app.innerHTML = renderQueue(state) + renderAsk(state, ask, askChoice);
  } else {
    app.innerHTML = renderList(state);
    marquee();
  }
  banner.className = state.daemonConnected ? 'banner' : 'banner show';
}

// Session names are measured against their tile after paint, so only the ones
// that genuinely overflow scroll. Guessing from character count would either
// animate names that fit or leave long ones clipped, and at 39px the line
// between the two moves with every name.
function marquee() {
  var names = app.querySelectorAll('[data-marquee]');
  for (var i = 0; i < names.length; i++) {
    var el = names[i];
    var over = el.scrollWidth - el.parentNode.clientWidth;
    if (over <= 2) continue;
    // Long names get proportionally longer to read, with a dwell at each end.
    var ms = 7000 + Math.round(over * 26);
    el.style.animation = 'marquee' + ' ' + ms + 'ms linear infinite';
    el.style.setProperty('--shift', '-' + over + 'px');
  }
}

function indexOfAsk(id) {
  var asks = store.get().asks;
  for (var i = 0; i < asks.length; i++) if (asks[i].id === id) return i;
  return 0;
}

window.addEventListener('hashchange', function () { askChoice = 0; render(); });
store.subscribe(render);
var EXPIRED_ASK_TTL_MS = 5 * 60 * 1000;
setInterval(function () {
  store.sweepExpired(EXPIRED_ASK_TTL_MS);
  var r = route();
  // clock ticks and queue wait ages
  if (r.name === 'ambient' || r.name === 'list' || r.name === 'queue') render();
}, 15000);

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
    if (n) store.update({ queueIndex: Math.max(0, Math.min(n - 1, state.queueIndex + dir)) });
  } else if (r.name === 'list') {
    var m = state.sessions.length;
    if (m) store.update({ selectedIndex: Math.max(0, Math.min(m - 1, state.selectedIndex + dir)) });
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
    // Triage without leaving the queue: a permission can be allowed in place,
    // because allow/deny is the whole decision. A question can't — it needs its
    // option list — so that one still opens the prompt.
    var a = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
    if (!a) return;
    if (a.kind === 'permission' && !a.expired) answerFromQueue(a, 0);
    else openAsk(a.id);
  } else if (r.name === 'list') {
    var s = state.sessions[state.selectedIndex];
    if (s) openSession(s.id);
  } else if (r.name === 'ambient') {
    nav('#/list');
  }
});

onAction('back', function () {
  var r = route();
  if (r.name === 'ask') skipAsk(r.arg);
  else if (r.name === 'session') nav('#/list');
  else if (r.name === 'queue' || r.name === 'usage') nav('#/list');
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
    if (hero && hero.kind === 'permission' && !hero.expired) answerFromQueue(hero, 1);
  }
});

onAction('ambient', function () {
  nav(route().name === 'ambient' ? '#/list' : '#/ambient');
});

onAction('tap', function (t) {
  var state = store.get();
  var hero = state.asks[Math.min(state.queueIndex, state.asks.length - 1)];
  if (t.action === 'open' && t.id) openSession(t.id);
  else if (t.action === 'open-ask' && t.id) openAsk(t.id);
  else if (t.action === 'ask-choice') answerAsk(route().arg, Number(t.id));
  else if (t.action === 'ask-skip') skipAsk(route().arg);
  else if (t.action === 'queue-allow' && hero) answerFromQueue(hero, 0);
  else if (t.action === 'queue-deny' && hero) answerFromQueue(hero, 1);
  else if (t.action === 'queue-answer' && hero) openAsk(hero.id);
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

function answerAsk(id, choice) {
  var ask = store.getAsk(id);
  if (!ask) return;
  // The hook already answered "ask" and closed; a decision now has nowhere to
  // go. Dismiss it rather than pretending the press did something.
  if (ask.expired) return skipAsk(id);

  if (ask.kind === 'question') {
    var option = (ask.options || [])[choice];
    if (!option) return;
    ws.request('claude.question.answer', { id: id, optionIndex: choice })
      .then(function (res) { toast(questionToast(res, choice)); })
      .catch(function () { toast('SEND FAILED'); });
    return;
  }

  if (choice === 2) return skipAsk(id);
  var decision = choice === 0 ? 'allow' : 'deny';
  ws.request('claude.permission.answer', { requestId: id, decision: decision })
    .then(function (res) {
      if (!res.accepted) toast('ALREADY ANSWERED');
    })
    .catch(function () { toast('SEND FAILED'); });
}

// Answering from the queue must leave you on the queue with the next ask
// promoted into the hero — not fling you into the next item's prompt screen.
// returnTo is what nextAskOrBack() checks to suppress that jump.
function answerFromQueue(ask, choice) {
  returnTo = '#/queue';
  toast(choice === 0 ? 'ALLOW' : 'DENY');
  answerAsk(ask.id, choice);
}

// A question can only be answered by typing into its terminal, so say exactly
// how far we got: typed it, focused the window for you, or neither and why.
function questionToast(res, choice) {
  if (res.viaKeyboard) return 'ANSWERED ON MAC';
  var why = String(res.reason || '');
  if (res.focused) return 'FOCUSED — PRESS ' + (choice + 1) + ' ON MAC';
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
    nav('#/ask/' + asks[0].id);
  } else {
    nav(returnTo);
  }
}

// ---- daemon events ----------------------------------------------------------

ws.on('claude.sessions.update', function (snap) { store.applySnapshot(snap); });
ws.on('claude.session.update', function (d) { store.applyDetail(d); });
ws.on('claude.usage.update', function (u) { store.update({ usage: u }); });

function surface(ask) {
  store.pushAsk(ask);
  var r = route();
  if (r.name !== 'ask') {
    returnTo = window.location.hash || '#/list';
    askChoice = 0;
    nav('#/ask/' + ask.id);
  } else {
    render();   // update the queue counter behind the current prompt
  }
}

ws.on('claude.permission.request', function (p) {
  surface({
    kind: 'permission',
    id: p.requestId,
    sessionId: p.sessionId,
    tool: p.tool,
    summary: p.summary,
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
    options: q.options || [],
    multiSelect: !!q.multiSelect,
    createdTs: q.createdTs,
  });
});

function onResolved(id, resolution) {
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

ws.on('claude.permission.resolved', function (p) { onResolved(p.requestId, p.resolution); });
ws.on('claude.question.resolved', function (q) { onResolved(q.id, q.resolution); });

ws.on('claude.daemon.status', function (s) {
  store.update({ daemonConnected: !!s.connected });
});

// ---- boot -------------------------------------------------------------------

ws.onOpen(function () {
  ws.request('claude.sessions.list', {}).then(function (snap) {
    store.update({ daemonConnected: true });
    store.applySnapshot(snap);
  }).catch(function () {
    store.update({ daemonConnected: false });
  });

  // anything already waiting before this app loaded
  ws.request('claude.queue.list', {}).then(function (res) {
    var asks = res.asks || [];
    for (var i = 0; i < asks.length; i++) store.pushAsk(asks[i]);
    if (asks.length && route().name === 'list') {
      returnTo = '#/list';
      nav('#/ask/' + asks[0].id);
    }
  }).catch(function () {});

  ws.request('claude.usage.get', {}).then(function (u) {
    store.update({ usage: u });
  }).catch(function () {});
});

render();
