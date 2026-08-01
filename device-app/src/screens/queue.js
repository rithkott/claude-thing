import { esc, topbar, isDestructive } from './helpers.js';
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
  // An intent line costs the hero ~27px, so the stack gives one row back.
  var rows = '';
  if (!answering) {
    var stackMax = heroAsk.intent ? STACK_MAX - 1 : STACK_MAX;
    var rest = [];
    for (var i = 0; i < state.asks.length && rest.length < stackMax; i++) {
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
    '<div class="qwrap">' + hero(heroAsk, answering, state.queueChoice, state.armed) + rows +
    '<div class="qfoot"><span>' + esc(foot) + '</span>' +
    '<span class="qfoothint">' + esc(hint) + '</span></div>' +
    '</div></div>';
}

function hero(a, answering, choice, armed) {
  var isQuestion = a.kind === 'question';
  var kindClass = isQuestion ? ' question' : '';
  var nasty = !isQuestion && !a.expired && isDestructive(a);
  // A question hero opens its options in place; a permission (or an expired
  // ask) still routes to the prompt screen on tap.
  var action = isQuestion && !a.expired ? 'queue-answer' : 'open-ask';
  var kind = isQuestion ? 'QUESTION'
    : nasty ? 'PERMISSION REQUEST · DESTRUCTIVE' : 'PERMISSION REQUEST';
  // A command without intent is an approval made blind: what you asked for
  // sits right under the session name, and the layout pays for the line — the
  // name steps down and the stack loses a row (see renderQueue).
  var intent = a.intent
    ? '<div class="qintent">' + esc(a.intent) + '</div>' : '';
  return '<div class="qhero' + kindClass + (a.expired ? ' expired' : '') +
    (answering ? ' answering' : '') +
    (a.intent ? ' has-intent' : '') +
    (nasty ? ' destructive' : '') +
    '" data-action="' + action + '" data-id="' + esc(a.id) + '">' +
    '<span class="qhazard"></span>' +
    '<div class="qherobody">' +
    '<div class="qheroline"><span class="qkind">' + kind + '</span>' +
    '<span class="qwait">' + esc(waitLabel(a)) + '</span></div>' +
    '<div class="qherosession">' + esc(a.sessionName || 'session') + '</div>' +
    intent +
    '<div class="qherosummary">' + esc(summarize(a)) + '</div>' +
    (answering ? heroOptions(a, choice) : heroActions(a, isQuestion, nasty, armed)) +
    '</div></div>';
}

// A timed-out permission has nothing left to press: the hook response is spent,
// so the chips are replaced by where the decision actually went.
function heroActions(a, isQuestion, nasty, armed) {
  if (a.expired) {
    return '<div class="qactions"><div class="qexpired">HOOK TIMED OUT — ANSWER IN TERMINAL</div></div>';
  }
  if (isQuestion) {
    var n = (a.options || []).length;
    return '<div class="qactions">' +
      chip('answer', 'ANSWER', n + ' option' + (n === 1 ? '' : 's') + ' · press dial', true) +
      '</div>';
  }
  // A destructive command must not cost the same gesture as "read that file":
  // the chip starts as an outline that says so, and the first press only arms
  // it — filled danger, PRESS AGAIN — for a 4s window.
  var isArmed = !!(armed && armed.id === a.id);
  var allow;
  if (isArmed) {
    allow = chip('allow', 'PRESS AGAIN', 'this cannot be undone', true, ' armed');
  } else if (nasty) {
    allow = chip('allow', 'ALLOW', 'press twice · destructive', false, ' destructive');
  } else {
    allow = chip('allow', 'ALLOW', 'press dial', true);
  }
  return '<div class="qactions">' + allow +
    chip('deny', 'DENY', 'preset 4', false) +
    '</div>';
}

// All options at once, no 3-wide window: the rows flex to share whatever
// height the (shrunken) name and question leave, so the whole decision is on
// screen before the first dial turn.
//
// Unselected rows stay one clipped line each; the row under the cursor grows
// and stacks its label over its description with both wrapping, so the text
// you are about to commit to is read in full, not guessed from an ellipsis.
// Every dial turn re-renders the list, so the markup can differ per row.
function heroOptions(a, choice) {
  var opts = a.options || [];
  var html = '<div class="qopts">';
  for (var i = 0; i < opts.length; i++) {
    var num = '<span class="qnum">' + (i + 1) + '</span>';
    var desc = opts[i].description
      ? '<span class="qdesc">' + esc(opts[i].description) + '</span>' : '';
    if (i === choice) {
      html += '<div class="qopt selected" data-action="queue-choice" data-id="' + i + '">' +
        num + '<div class="qtext"><span class="qlabel">' + esc(opts[i].label) + '</span>' +
        desc + '</div></div>';
    } else {
      html += '<div class="qopt" data-action="queue-choice" data-id="' + i + '">' +
        num + '<span class="qlabel">' + esc(opts[i].label) + '</span>' + desc +
        '</div>';
    }
  }
  return html + '</div>';
}

function chip(action, label, hint, filled, extra) {
  return '<div class="qchip ' + action + (filled ? ' filled' : '') + (extra || '') +
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
