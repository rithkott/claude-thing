import { esc, topbar } from './helpers.js';

// Everything waiting on a human, oldest first — tool permissions and
// multiple-choice questions in one list.
export function renderQueue(state) {
  var bar = topbar('QUEUE' + (state.asks.length ? ' · ' + state.asks.length : ''), state.daemonConnected);

  if (!state.asks.length) {
    return '<div class="screen">' + bar +
      '<div class="empty">NOTHING WAITING ON YOU</div></div>';
  }

  var rows = '';
  for (var i = 0; i < state.asks.length; i++) {
    var a = state.asks[i];
    var isQuestion = a.kind === 'question';
    rows +=
      '<div class="qrow' + (i === state.queueIndex ? ' selected' : '') +
      '" data-action="open-ask" data-id="' + esc(a.id) + '">' +
      '<span class="qrail' + (isQuestion ? ' question' : '') + '"></span>' +
      '<div class="qinfo">' +
      '<div class="qhead"><span class="qkind' + (isQuestion ? ' question' : '') + '">' +
      (isQuestion ? 'QUESTION' : 'PERMISSION') + '</span>' +
      '<span class="qsession">' + esc(a.sessionName || 'session') + '</span></div>' +
      '<div class="qsummary">' + esc(summarize(a)) + '</div>' +
      '</div>' +
      '<div class="qmeta">' + esc(waitLabel(a)) + '</div>' +
      '</div>';
  }

  return '<div class="screen">' + bar + '<div class="qlist">' + rows + '</div></div>';
}

function summarize(a) {
  if (a.kind === 'question') {
    var n = (a.options || []).length;
    return a.question + '  (' + n + ' option' + (n === 1 ? '' : 's') + ')';
  }
  return a.tool + ': ' + a.summary;
}

function waitLabel(a) {
  var secs = Math.max(0, Math.round((Date.now() - a.createdTs) / 1000));
  if (a.timeoutMs) {
    var left = Math.max(0, Math.round((a.createdTs + a.timeoutMs - Date.now()) / 1000));
    return left + 's left';
  }
  return secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm';
}
