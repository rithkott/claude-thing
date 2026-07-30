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
  }
  banner.className = state.daemonConnected ? 'banner' : 'banner show';
}

function indexOfAsk(id) {
  var asks = store.get().asks;
  for (var i = 0; i < asks.length; i++) if (asks[i].id === id) return i;
  return 0;
}

window.addEventListener('hashchange', function () { askChoice = 0; render(); });
store.subscribe(render);
setInterval(function () {
  var r = route();
  // clock ticks and queue wait timers
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
    var a = state.asks[state.queueIndex];
    if (a) openAsk(a.id);
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

onAction('deny', function () {
  var r = route();
  if (r.name !== 'ask') return;
  var ask = store.getAsk(r.arg);
  if (ask && ask.kind === 'permission') answerAsk(r.arg, 1);   // 1 = deny
});

onAction('ambient', function () {
  nav(route().name === 'ambient' ? '#/list' : '#/ambient');
});

onAction('tap', function (t) {
  if (t.action === 'open' && t.id) openSession(t.id);
  else if (t.action === 'open-ask' && t.id) openAsk(t.id);
  else if (t.action === 'ask-choice') answerAsk(route().arg, Number(t.id));
  else if (t.action === 'ask-skip') skipAsk(route().arg);
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
  store.resolveAsk(id);
  if (wasCurrent) {
    toast(resolution === 'timeout' ? 'TIMED OUT — ANSWER IN TERMINAL' : String(resolution).toUpperCase());
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
