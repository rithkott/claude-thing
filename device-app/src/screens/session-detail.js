import { esc, topbar, fmtTokens, fmtDuration, stateLabel } from './helpers.js';
import { now } from '../clock.js';

// Same reading as the tile, with room for the number to breathe. Absent when
// the daemon can't work the fraction out — no meter beats a made-up one.
function contextMeter(fraction) {
  if (fraction == null) return '';
  var pct = Math.max(0, Math.min(1, fraction));
  return '<div class="dctx' + (pct >= 0.8 ? ' hot' : '') + '">' +
    '<div class="dctxrow"><span class="dctxpct">' + Math.round(pct * 100) + '%</span>' +
    '<span class="dctxlabel">context used</span></div>' +
    '<div class="dctxtrack"><span class="dctxfill" style="width:' + (pct * 100).toFixed(1) + '%"></span></div>' +
    '</div>';
}

export function renderDetail(state, id) {
  var d = state.details[id];
  if (!d) {
    return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
      '<div class="empty">LOADING…</div></div>';
  }
  var meta = [
    d.cwd ? d.cwd.split('/').pop() : null,
    d.model ? d.model.replace(/^claude-/, '') : null,
    d.startedTs ? fmtDuration(now() - d.startedTs) : null,
  ];
  var metaStr = [];
  for (var i = 0; i < meta.length; i++) if (meta[i]) metaStr.push(meta[i]);

  return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
    '<div class="detail state-' + d.state + '">' +
    '<div class="name">' + esc(d.name) + '</div>' +
    '<div class="meta">' + esc(metaStr.join(' · ')) + '</div>' +
    '<div class="activity">' + esc(d.currentTool ? d.currentTool + ' — working' : 'no active tool') + '</div>' +
    '<div class="lasttext">' + esc(d.lastMessage || '') + '</div>' +
    contextMeter(d.context) +
    '<div class="statsrow">' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.out) + '</div><div class="k">tokens out</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.in) + '</div><div class="k">tokens in</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.cacheRead) + '</div><div class="k">cache read</div></div>' +
    '<div class="stat"><div class="v">' + stateLabel(d.state, d.ended) + '</div><div class="k">state</div></div>' +
    '</div></div></div>';
}
