import { esc } from './helpers.js';
import { now } from '../clock.js';

// Fullscreen prompt view — the focused answer screen, opened from a session or
// from the queue. Unlike the queue this one keeps a countdown, because here you
// are acting against a live deadline rather than surveying what is waiting.
export function renderAsk(state, ask, choice) {
  return ask.kind === 'question'
    ? renderQuestion(state, ask, choice)
    : renderPermissionAsk(state, ask, choice);
}

function head(ask, label, klass) {
  var queue = state_queuePos();
  return '<span class="hazard' + (klass || '') + '"></span>' +
    countdown(ask) +
    '<div class="head"><span class="lamp attention"></span>' +
    '<span class="who">' + label + '</span>' +
    remaining(ask) +
    (queue ? '<span class="queuen">' + queue + '</span>' : '') + '</div>' +
    '<div class="session">' + esc(ask.sessionName || 'session') +
    (ask.kind === 'permission' && ask.tool
      ? '<span class="stool">' + esc(ask.tool) + '</span>' : '') +
    '</div>';
}

function fractionLeft(ask) {
  if (!ask.timeoutMs || ask.expired) return null;
  var left = ask.createdTs + ask.timeoutMs - now();
  return Math.max(0, Math.min(1, left / ask.timeoutMs));
}

function countdown(ask) {
  var frac = fractionLeft(ask);
  if (frac === null) return '';
  var secs = Math.round((ask.createdTs + ask.timeoutMs - now()) / 1000);
  return '<div class="cdtrack"><span class="cdfill' + (secs <= 10 ? ' urgent' : '') +
    '" style="width:' + (frac * 100).toFixed(1) + '%"></span></div>';
}

function remaining(ask) {
  var frac = fractionLeft(ask);
  if (frac === null) return '';
  var secs = Math.max(0, Math.round((ask.createdTs + ask.timeoutMs - now()) / 1000));
  var text = secs >= 60 ? Math.round(secs / 60) + 'm left' : secs + 's left';
  return '<span class="cdtime' + (secs <= 10 ? ' urgent' : '') + '">' + text + '</span>';
}

// filled in by renderAsk callers via setQueueContext
var queueContext = { index: 0, total: 1 };
export function setQueueContext(index, total) {
  queueContext = { index: index, total: total };
}
function state_queuePos() {
  return queueContext.total > 1 ? (queueContext.index + 1) + ' / ' + queueContext.total : '';
}

function renderPermissionAsk(state, ask, choice) {
  // Nothing on the device can answer this any more: the hook's response is
  // spent, so allow/deny would write to a closed connection. Say where the
  // decision went and offer only dismissal.
  if (ask.expired) {
    return '<div class="perm expired">' + head(ask, 'PERMISSION REQUEST') +
      '<div class="cmd">' + esc(ask.summary) + '</div>' +
      '<div class="expnote">HOOK TIMED OUT — ANSWER IN TERMINAL</div>' +
      '<div class="actions">' +
      '<div class="pbtn dismiss selected" data-action="ask-skip">' +
      '<span class="a">DISMISS</span><span class="h">back</span></div>' +
      '</div></div>';
  }
  return '<div class="perm">' + head(ask, 'PERMISSION REQUEST') +
    '<div class="cmd">' + esc(ask.summary) + '</div>' +
    '<div class="actions">' +
    '<div class="pbtn allow' + (choice === 0 ? ' selected' : '') + '" data-action="ask-choice" data-id="0">' +
    '<span class="a">ALLOW</span><span class="h">press dial</span></div>' +
    '<div class="pbtn deny' + (choice === 1 ? ' selected' : '') + '" data-action="ask-choice" data-id="1">' +
    '<span class="a">DENY</span><span class="h">preset 4</span></div>' +
    '<div class="pbtn dismiss' + (choice === 2 ? ' selected' : '') + '" data-action="ask-skip">' +
    '<span class="a">SKIP</span><span class="h">back</span></div>' +
    '</div></div>';
}

function renderQuestion(state, ask, choice) {
  var options = ask.options || [];
  // keep the cursor on screen: a window of 3 options at a time
  var start = Math.max(0, Math.min(choice - 1, options.length - 3));
  if (start < 0) start = 0;
  var shown = options.slice(start, start + 3);

  var opts = '';
  for (var i = 0; i < shown.length; i++) {
    var idx = start + i;
    var o = shown[i];
    opts +=
      '<div class="qopt' + (idx === choice ? ' selected' : '') +
      '" data-action="ask-choice" data-id="' + idx + '">' +
      '<span class="qnum">' + (idx + 1) + '</span>' +
      '<div class="qtext"><div class="qlabel">' + esc(o.label) + '</div>' +
      (o.description ? '<div class="qdesc">' + esc(o.description) + '</div>' : '') +
      '</div></div>';
  }
  var more = options.length > 3
    ? '<div class="qmore">' + (choice + 1) + ' / ' + options.length + ' · turn dial for more</div>'
    : '';

  return '<div class="perm question">' + head(ask, esc(ask.header || 'QUESTION'), ' coral') +
    '<div class="qprompt">' + esc(ask.question) + '</div>' +
    '<div class="qopts">' + opts + '</div>' + more +
    '<div class="qhint">dial answers · back leaves it</div>' +
    '</div>';
}
