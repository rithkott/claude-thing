import { esc, topbar } from './helpers.js';

// The real /usage figures: plan-limit percentages with reset times, plus the
// "what's contributing" breakdown. The mascot's mood tracks the fullest bar.
export function renderUsage(state) {
  var u = state.usage;
  var bar = topbar('USAGE', state.daemonConnected);

  if (!u || !u.limits || !u.limits.length) {
    return '<div class="screen">' + bar +
      '<div class="empty">' + esc(u && u.error ? u.error : 'READING USAGE…') + '</div></div>';
  }

  var rows = '';
  for (var i = 0; i < u.limits.length; i++) {
    var l = u.limits[i];
    var pct = Math.max(0, Math.min(1, l.used || 0));
    rows +=
      '<div class="ubar">' +
      '<div class="uhead"><span class="ulabel">' + esc(l.label) + '</span>' +
      '<span class="ureset">' + esc(l.detail || '') + '</span>' +
      '<span class="upct">' + Math.round(pct * 100) + '%</span></div>' +
      '<div class="utrack"><span class="ufill ' + level(pct) + '" style="width:' +
      (pct * 100).toFixed(1) + '%"></span></div>' +
      '</div>';
  }

  var worst = 0;
  for (var j = 0; j < u.limits.length; j++) worst = Math.max(worst, u.limits[j].used || 0);

  // the most recent window's headline numbers and its top contributors
  var w = (u.windows || [])[0];
  var notes = '';
  if (w) {
    var items = (w.notes || []).slice(0, 3);
    var lines = '';
    for (var k = 0; k < items.length; k++) {
      lines += '<div class="unote">' + esc(items[k]) + '</div>';
    }
    notes = '<div class="ucontrib">' +
      '<div class="uwin">' + esc(w.window) + ' · ' + w.requests + ' requests · ' +
      w.sessions + ' sessions</div>' + lines + '</div>';
  }

  return '<div class="screen">' + bar +
    '<div class="usage">' +
    '<div class="ubars">' + rows + notes + '</div>' +
    '<div class="umascot"><span class="usprite ' + mood(worst) + '"></span>' +
    '<span class="umood">' + moodLabel(worst) + '</span></div>' +
    '</div>' +
    '<div class="ufoot">' + esc(u.updatedLabel || '') + (u.stale ? ' · stale' : '') + '</div>' +
    '</div>';
}

function level(pct) {
  if (pct >= 0.9) return 'hot';
  if (pct >= 0.6) return 'warm';
  return 'cool';
}

function mood(pct) {
  if (pct >= 0.9) return 'mood-max';
  if (pct >= 0.75) return 'mood-hot';
  if (pct >= 0.4) return 'mood-warm';
  return 'mood-calm';
}

function moodLabel(pct) {
  if (pct >= 0.9) return 'AT THE LIMIT';
  if (pct >= 0.75) return 'EASE OFF';
  if (pct >= 0.4) return 'PLENTY LEFT';
  return 'ALL CLEAR';
}
