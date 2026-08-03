// The answer is not in the terminal the moment you press SUBMIT.
//
// Two waits sit between that press and the keystrokes landing on the Mac: the
// undo window the device holds the answer in, and the daemon focusing the
// window and typing the sequence out one key at a time. Both are seconds long,
// and until now the device showed nothing for either — the card left the queue
// at once, so the screen you were left staring at said NOTHING WAITING ON YOU
// while the answer had not been sent yet. A wait with no sign of progress reads
// as a bug, and pressing again is exactly the wrong reaction.
//
// So the wait gets a face: one indicator that runs from the press until the
// daemon says how it went. Pure so the phases can be tested without a browser.

// The undo window is the one wait whose length is known up front, so its ring
// drains rather than spins — the animation IS the countdown, which is also why
// it is handed back as a duration for CSS to run rather than ticked in JS.
export function inflight(state, undoMs) {
  if (state.sending) {
    return {
      phase: 'sending',
      // Naming the machine matters: nothing on the device is doing this work,
      // and "typing" is literally what is happening over there.
      label: state.sending.kind === 'question' ? 'TYPING ON MAC' : 'SENDING TO MAC',
      ms: 0,
    };
  }
  if (state.undo) {
    return { phase: 'undo', label: undoLabel(state.undo) + ' · BACK TO UNDO', ms: undoMs };
  }
  return null;
}

// The verb the queue toast used to carry. It moved here because the indicator
// now says it for as long as it is true, instead of for the 2.5s a toast lives.
export function undoLabel(undo) {
  if (!undo || !undo.ask) return 'ANSWERED';
  if (undo.ask.kind === 'question') return 'ANSWERED';
  return undo.choice === 0 ? 'ALLOW' : 'DENY';
}
