import { esc, topbar, fmtTokens, fmtDuration, stateLabel } from './helpers.js';

export function renderDetail(state, id) {
  var d = state.details[id];
  if (!d) {
    return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
      '<div class="empty">LOADING…</div></div>';
  }
  var meta = [
    d.cwd ? d.cwd.split('/').pop() : null,
    d.model ? d.model.replace(/^claude-/, '') : null,
    d.startedTs ? fmtDuration(Date.now() - d.startedTs) : null,
  ];
  var metaStr = [];
  for (var i = 0; i < meta.length; i++) if (meta[i]) metaStr.push(meta[i]);

  return '<div class="screen">' + topbar('SESSION', state.daemonConnected) +
    '<div class="detail state-' + d.state + '">' +
    '<div class="name">' + esc(d.name) + '</div>' +
    '<div class="meta">' + esc(metaStr.join(' · ')) + '</div>' +
    '<div class="activity">' + esc(d.currentTool ? d.currentTool + ' — working' : 'no active tool') + '</div>' +
    '<div class="lasttext">' + esc(d.lastMessage || '') + '</div>' +
    '<div class="statsrow">' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.out) + '</div><div class="k">tokens out</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.tokens.in) + '</div><div class="k">tokens in</div></div>' +
    '<div class="stat"><div class="v">' + fmtTokens(d.cacheRead) + '</div><div class="k">cache read</div></div>' +
    '<div class="stat"><div class="v">' + stateLabel(d.state, d.ended) + '</div><div class="k">state</div></div>' +
    '</div></div></div>';
}
