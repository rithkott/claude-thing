import { fmtTokens } from './helpers.js';
import { fmtClock } from '../clock.js';

// The resting screen works as a desk clock: the clock stays the hero, and the
// status line sits immediately beneath it, where the eye already is. Blocked
// state is carried by colour and motion (plus the pulsing panel edge), never
// by outgrowing the clock.
export function renderAmbient(state) {
  var lamps = '';
  for (var i = 0; i < state.sessions.length && i < 8; i++) {
    lamps += '<span class="lamp ' + state.sessions[i].state + '"></span>';
  }
  var working = state.stats.active || 0;
  var resting = Math.max(0, state.sessions.length - working);
  var totalOut = 0;
  for (var j = 0; j < state.sessions.length; j++) totalOut += state.sessions[j].tokens.out || 0;

  var blocked = state.asks.length;
  var head = blocked
    ? '<div class="ahead blocked">' + blocked + (blocked === 1 ? ' NEEDS YOU' : ' NEED YOU') + '</div>'
    : '<div class="ahead">NOTHING BLOCKED</div>';

  // The whole screen is the mascot's switch: he wanders everywhere, so no
  // fixed hotspot could reliably be "on him", and the clock has no other tap
  // target to collide with.
  return '<div class="screen ambient" data-action="mascot-toggle">' +
    '<div class="bigclock">' + fmtClock() + '</div>' +
    head +
    '<div class="caption">' + working + ' WORKING · ' + resting + ' RESTING</div>' +
    (lamps ? '<div class="fleet">' + lamps + '</div>' : '') +
    '<div class="tokens">' + fmtTokens(totalOut) + ' tokens out</div>' +
    '<div class="hint">' + (blocked ? 'press dial to answer' : 'press dial for sessions') + '</div>' +
    '</div>';
}
