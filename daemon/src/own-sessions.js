// The daemon shells out to Claude Code to read usage, and each of those runs is
// itself a Claude Code session — which `claude agents --json` reports (that
// listing is project-scoped, so the daemon sees its own spawns) and which would
// otherwise show up on the device as phantom "daemon" sessions.
//
// Every spawn gets an explicit --session-id recorded here, and the session
// sources skip anything in this set. Bounded so it cannot grow without limit.

const MAX = 40;
const own = new Set();

export function markOwnSession(id) {
  own.add(id);
  if (own.size > MAX) {
    // drop the oldest insertions; Set preserves insertion order
    const excess = own.size - MAX;
    let i = 0;
    for (const key of own) {
      if (i++ >= excess) break;
      own.delete(key);
    }
  }
}

export function isOwnSession(id) {
  return own.has(id);
}
