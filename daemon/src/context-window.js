// Context window sizes per model.
//
// The transcript gives what a turn sent, which is the occupancy. It does not
// carry the ceiling, and nothing else in the session data does either — so the
// denominator has to come from a table. Claude Code knows the real number (it
// hands `context_window_size` to statusLine commands), and if this daemon ever
// grows a statusLine hook, prefer that over this file.
//
// An unknown model returns null, and the device hides the meter rather than
// drawing a bar against a guess.

const MILLION = 1_000_000;

const SIZES = [
  [/opus-5|fable-5|mythos|sonnet-5/, MILLION],
  [/opus-4|sonnet-4-6|sonnet-4\.6/, MILLION],
  [/haiku/, 200_000],
];

export function contextWindowFor(model) {
  const id = String(model || '');
  if (!id) return null;
  for (const [pattern, size] of SIZES) {
    if (pattern.test(id)) return size;
  }
  return null;
}

// 0..1, or null when either half of the fraction is unknown.
export function contextFraction(model, tokens) {
  const size = contextWindowFor(model);
  if (!size || !tokens) return null;
  return Math.max(0, Math.min(1, tokens / size));
}
