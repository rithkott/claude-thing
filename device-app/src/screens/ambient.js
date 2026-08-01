import { fmtTokens } from './helpers.js';
import { fmtClock } from '../clock.js';

export function renderAmbient(state) {
  var lamps = '';
  for (var i = 0; i < Math.max(state.sessions.length, 1) && i < 8; i++) {
    var s = state.sessions[i];
    lamps += '<span class="lamp ' + (s ? s.state : 'idle') + '"></span>';
  }
  var working = state.stats.active || 0;
  var totalOut = 0;
  for (var j = 0; j < state.sessions.length; j++) totalOut += state.sessions[j].tokens.out || 0;

  return '<div class="screen ambient">' +
    '<div class="bigclock">' + fmtClock() + '</div>' +
    '<div class="fleet">' + lamps + '</div>' +
    '<div class="caption">' + working + ' WORKING' +
    (state.stats.attention ? ' · ' + state.stats.attention + ' NEED YOU' : '') + '</div>' +
    '<div class="tokens">' + fmtTokens(totalOut) + ' tokens out</div>' +
    '<div class="hint">press dial for sessions</div>' +
    '</div>';
}
