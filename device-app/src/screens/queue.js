import { esc, topbar } from './helpers.js';
import { now } from '../clock.js';

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
  // A question is answered in place: its option list opens inside the hero
  // rather than routing to a whole-screen prompt for one press.
  var answering = !!state.queueAnswering &&
    heroAsk.kind === 'question' && !heroAsk.expired;

  // While the list is open the stack rows give it their room; the footer keeps
  // the queue context alive so closing the list isn't a leap of faith.
  var rows = '';
  if (!answering) {
    var rest = [];
    for (var i = 0; i < state.asks.length && rest.length < STACK_MAX; i++) {
      if (state.asks[i].id !== heroAsk.id) rest.push(state.asks[i]);
    }
    for (var j = 0; j < rest.length; j++) rows += stackRow(rest[j]);
  }

  var foot, hint;
  if (answering) {
    var others = state.asks.length - 1;
    foot = others > 0 ? others + ' more waiting' : 'last one';
    hint = 'dial moves · press answers · back closes';
  } else {
    var shown = 1 + Math.min(STACK_MAX, state.asks.length - 1);
    foot = state.asks.length + ' waiting on you' +
      (state.asks.length > shown ? ' · showing ' + shown : '');
    hint = 'turn dial or swipe for the next one';
  }

  return '<div class="screen">' + bar +
    '<div class="qwrap">' + hero(heroAsk, answering, state.queueChoice) + rows +
    '<div class="qfoot"><span>' + esc(foot) + '</span>' +
    '<span class="qfoothint">' + esc(hint) + '</span></div>' +
    '</div></div>';
}

function hero(a, answering, choice) {
  var isQuestion = a.kind === 'question';
  var kindClass = isQuestion ? ' question' : '';
  // A question hero opens its options in place; a permission (or an expired
  // ask) still routes to the prompt screen on tap.
  var action = isQuestion && !a.expired ? 'queue-answer' : 'open-ask';
  return '<div class="qhero' + kindClass + (a.expired ? ' expired' : '') +
    (answering ? ' answering' : '') +
    '" data-action="' + action + '" data-id="' + esc(a.id) + '">' +
    '<span class="qhazard"></span>' +
    '<div class="qherobody">' +
    '<div class="qheroline"><span class="qkind">' +
    (isQuestion ? 'QUESTION' : 'PERMISSION REQUEST') + '</span>' +
    '<span class="qwait">' + esc(waitLabel(a)) + '</span></div>' +
    '<div class="qherosession">' + esc(a.sessionName || 'session') + '</div>' +
    '<div class="qherosummary">' + esc(summarize(a)) + '</div>' +
    (answering ? heroOptions(a, choice) : heroActions(a, isQuestion)) +
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

// All options at once, no 3-wide window: the rows flex to share whatever
// height the (shrunken) name and question leave, so the whole decision is on
// screen before the first dial turn.
function heroOptions(a, choice) {
  var opts = a.options || [];
  var html = '<div class="qopts">';
  for (var i = 0; i < opts.length; i++) {
    html += '<div class="qopt' + (i === choice ? ' selected' : '') +
      '" data-action="queue-choice" data-id="' + i + '">' +
      '<span class="qnum">' + (i + 1) + '</span>' +
      '<span class="qlabel">' + esc(opts[i].label) + '</span>' +
      (opts[i].description ? '<span class="qdesc">' + esc(opts[i].description) + '</span>' : '') +
      '</div>';
  }
  return html + '</div>';
}

function chip(action, label, hint, filled) {
  return '<div class="qchip ' + action + (filled ? ' filled' : '') +
    '" data-action="queue-' + action + '">' +
    '<span class="qchiplabel">' + label + '</span>' +
    '<span class="qchiphint">' + esc(hint) + '</span></div>';
}

// Tapping a stack row promotes it to hero rather than opening the prompt: the
// hero is where every ask is now answerable, so that is where a tap should
// land it.
function stackRow(a) {
  var isQuestion = a.kind === 'question';
  return '<div class="qrow' + (isQuestion ? ' question' : '') +
    '" data-action="queue-promote" data-id="' + esc(a.id) + '">' +
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
  var secs = Math.max(0, Math.round((now() - a.createdTs) / 1000));
  return 'waiting ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm');
}
