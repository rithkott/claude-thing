import { esc, topbar } from './helpers.js';

// The real /usage figures: plan-limit percentages with reset times, plus the
// "what's contributing" breakdown. Each bar carries its own mascot driven by
// that bar's own fill, so the limits read as independent gauges rather than one
// verdict — being out of weekly Fable says nothing about your session limit.
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
    var m = mood(pct);
    rows +=
      '<div class="ubar">' +
      '<div class="ubarmain">' +
      '<div class="uhead"><span class="ulabel">' + esc(l.label) + '</span>' +
      '<span class="ureset">' + esc(l.detail || '') + '</span>' +
      '<span class="upct">' + Math.round(pct * 100) + '%</span></div>' +
      '<div class="utrack"><span class="ufill ' + m + '" style="width:' +
      (pct * 100).toFixed(1) + '%"></span></div>' +
      '</div>' +
      '<span class="usprite ' + m + '"></span>' +
      '<span class="uphrase ' + m + '">' + moodLabel(pct) + '</span>' +
      '</div>';
  }

  return '<div class="screen">' + bar +
    '<div class="usage">' + rows + tables(u) + '</div>' +
    '<div class="ufoot">' + esc(u.updatedLabel || '') + (u.stale ? ' · stale' : '') + '</div>' +
    '</div>';
}

// Below the divider: what the window actually was, then the two contributor
// tables side by side.
function tables(u) {
  var w = (u.windows || [])[0];
  if (!w) return '';
  var win = esc(w.window) + ' · ' + w.requests + ' requests · ' + w.sessions + ' sessions';
  return '<div class="ubreak">' +
    '<div class="uwin">' + win + '</div>' +
    '<div class="utables">' +
    table('SKILLS', w.skills || []) +
    table('SUBAGENTS', w.subagents || []) +
    '</div></div>';
}

function table(title, rows) {
  var body = '';
  for (var i = 0; i < rows.length && i < 3; i++) {
    body += '<div class="utrow"><span class="utname">' + esc(rows[i].name) + '</span>' +
      '<span class="utval">' + esc(rows[i].pct) + '</span></div>';
  }
  if (!body) body = '<div class="utrow"><span class="utname">—</span></div>';
  return '<div class="utable"><div class="uthead"><span class="uttitle">' + title + '</span>' +
    '<span class="utunit">% of usage</span></div>' + body + '</div>';
}

// Under 80% clear, 80–99% sweating, 100% fainted. The thresholds are the
// design's; the sprite and the fill colour always agree.
function mood(pct) {
  if (pct >= 1) return 'mood-out';
  if (pct >= 0.8) return 'mood-low';
  return 'mood-clear';
}

function moodLabel(pct) {
  if (pct >= 1) return 'OUT OF USAGE';
  if (pct >= 0.8) return 'RUNNING OUT';
  return 'ALL CLEAR';
}
