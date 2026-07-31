import { esc, topbar } from './helpers.js';

// Triage, not a list of equals: the ask you would answer next owns the page and
// carries its own actions, so a permission can be allowed without ever leaving
// this screen. Everything else stacks underneath as a preview of what's coming.
var STACK_MAX = 2;

export function renderQueue(state) {
  var bar = topbar('QUEUE', state.daemonConnected, state.asks.length ? String(state.asks.length) : '');

  if (!state.asks.length) {
    return '<div class="screen">' + bar +
      '<div class="qempty"><span class="qemptysprite"></span>' +
      '<div class="qemptytitle">NOTHING WAITING ON YOU</div>' +
      '<div class="qemptysub">permissions and questions land here</div></div></div>';
  }

  var index = Math.min(state.queueIndex, state.asks.length - 1);
  var heroAsk = state.asks[index];
  var rest = [];
  for (var i = 0; i < state.asks.length && rest.length < STACK_MAX; i++) {
    if (state.asks[i].id !== heroAsk.id) rest.push(state.asks[i]);
  }

  var rows = '';
  for (var j = 0; j < rest.length; j++) rows += stackRow(rest[j]);

  var shown = 1 + rest.length;
  var foot = state.asks.length + ' waiting on you' +
    (state.asks.length > shown ? ' · showing ' + shown : '');

  return '<div class="screen">' + bar +
    '<div class="qwrap">' + hero(heroAsk) + rows +
    '<div class="qfoot"><span>' + esc(foot) + '</span>' +
    '<span class="qfoothint">turn dial for the next one</span></div>' +
    '</div></div>';
}

function hero(a) {
  var isQuestion = a.kind === 'question';
  var kindClass = isQuestion ? ' question' : '';
  return '<div class="qhero' + kindClass + (a.expired ? ' expired' : '') +
    '" data-action="open-ask" data-id="' + esc(a.id) + '">' +
    '<span class="qhazard"></span>' +
    '<div class="qherobody">' +
    '<div class="qheroline"><span class="qkind">' +
    (isQuestion ? 'QUESTION' : 'PERMISSION REQUEST') + '</span>' +
    '<span class="qwait">' + esc(waitLabel(a)) + '</span></div>' +
    '<div class="qherosession">' + esc(a.sessionName || 'session') + '</div>' +
    '<div class="qherosummary">' + esc(summarize(a)) + '</div>' +
    heroActions(a, isQuestion) +
    '</div></div>';
}

// A timed-out permission has nothing left to press: the hook response is spent,
// so the chips are replaced by where the decision actually went.
function heroActions(a, isQuestion) {
  if (a.expired) {
    return '<div class="qactions"><div class="qexpired">HOOK TIMED OUT — ANSWER IN TERMINAL</div></div>';
  }
  if (isQuestion) {
    var n = (a.options || []).length;
    return '<div class="qactions">' +
      chip('answer', 'ANSWER', n + ' option' + (n === 1 ? '' : 's') + ' · press dial', true) +
      '</div>';
  }
  return '<div class="qactions">' +
    chip('allow', 'ALLOW', 'press dial', true) +
    chip('deny', 'DENY', 'preset 4', false) +
    '</div>';
}

function chip(action, label, hint, filled) {
  return '<div class="qchip ' + action + (filled ? ' filled' : '') +
    '" data-action="queue-' + action + '">' +
    '<span class="qchiplabel">' + label + '</span>' +
    '<span class="qchiphint">' + esc(hint) + '</span></div>';
}

function stackRow(a) {
  var isQuestion = a.kind === 'question';
  return '<div class="qrow' + (isQuestion ? ' question' : '') +
    '" data-action="open-ask" data-id="' + esc(a.id) + '">' +
    '<span class="qrail"></span>' +
    '<span class="qrowkind">' + (isQuestion ? 'QUESTION' : 'PERMISSION') + '</span>' +
    '<span class="qrowsession">' + esc(a.sessionName || 'session') + '</span>' +
    '<span class="qrowsummary">' + esc(summarize(a)) + '</span>' +
    '<span class="qrowwait">' + esc(waitLabel(a)) + '</span>' +
    '</div>';
}

function summarize(a) {
  if (a.kind === 'question') return a.question;
  return a.tool + '  ·  ' + a.summary;
}

// How long it has been waiting, never how long is left. A countdown turns a
// prompt into a deadline you can lose; the prompt screen is where a live
// deadline belongs, because that is where you are acting against it.
function waitLabel(a) {
  if (a.expired) return 'in terminal';
  var secs = Math.max(0, Math.round((Date.now() - a.createdTs) / 1000));
  return 'waiting ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm');
}
