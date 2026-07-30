// Merged session state + busy/attention/celebrate/idle machine.
// Sources call upsert()/touch()/remove(); the store owns state derivation and
// emits debounced full snapshots via onSnapshot.

import {
  SESSION_CAP, SNAPSHOT_DEBOUNCE_MS, BUSY_WINDOW_MS, CELEBRATE_MS, ENDED_TTL_MS,
  AGENT_ACTIVE_TTL_MS, THINKING_TTL_MS,
} from '../config.js';

export function createStore() {
  const sessions = new Map(); // id -> internal record
  let snapshotTimer = null;
  let onSnapshot = () => {};
  let onDetail = () => {};

  // Thinking is silent: between submitting a prompt and the first tool call, and
  // between any two tool calls, nothing writes to the transcript and no hook
  // fires. Activity timestamps alone therefore decay to idle mid-turn, which is
  // exactly when the session is most obviously working. Two signals cover that
  // gap — the registry's own "working" verdict, and the prompt-submitted flag
  // that stands until Stop.
  function working(s, now) {
    if (s.ended) return false;
    if (s.thinking && now - (s.thinkingTs || 0) < THINKING_TTL_MS) return true;
    if (s.agentActive && now - (s.agentActiveTs || 0) < AGENT_ACTIVE_TTL_MS) return true;
    return now - s.lastActivityTs < BUSY_WINDOW_MS;
  }

  function deriveState(s) {
    const now = Date.now();
    if (s.pendingPermission || s.waitingForInput) return 'attention';
    if (s.stoppedTs && now - s.stoppedTs < CELEBRATE_MS) return 'celebrate';
    if (working(s, now)) return 'busy';
    return 'idle';
  }

  function summary(s) {
    return {
      id: s.id,
      name: (s.name || 'session').slice(0, 32),
      state: deriveState(s),
      lastActivityTs: s.lastActivityTs,
      tokens: { in: s.tokensIn || 0, out: s.tokensOut || 0 },
      pendingPermission: !!s.pendingPermission,
      // idle means "nothing recently"; ended means the session is over. The
      // device labels them differently, so both have to travel.
      ended: !!s.ended,
    };
  }

  function detail(s) {
    return {
      ...summary(s),
      cacheRead: s.cacheRead || 0,
      cwd: s.cwd || '',
      model: s.model || '',
      startedTs: s.startedTs || s.lastActivityTs,
      currentTool: s.currentTool || null,
      lastMessage: (s.lastMessage || '').slice(0, 200),
      permission: s.permission || null,
    };
  }

  function snapshot(limit) {
    const ordered = [...sessions.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    const cap = limit || SESSION_CAP;   // 0 = unbounded
    const list = (cap > 0 ? ordered.slice(0, cap) : ordered).map(summary);
    const stats = {
      active: list.filter((s) => s.state === 'busy').length,
      attention: list.filter((s) => s.state === 'attention').length,
    };
    return { sessions: list, stats };
  }

  function scheduleSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      onSnapshot(snapshot());
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  function upsert(id, fields) {
    let s = sessions.get(id);
    if (!s) {
      s = { id, startedTs: Date.now(), lastActivityTs: Date.now() };
      sessions.set(id, s);
    }
    const wasThinking = s.thinking;
    Object.assign(s, fields);
    if (s.thinking && !wasThinking) s.thinkingTs = Date.now();
    // Stamp the moment it ended, so pruning measures from then. Keying off
    // lastActivityTs instead meant a session that worked right up to its exit
    // sat on screen for the whole TTL, while a quiet one vanished at once.
    if (s.ended && !s.endedTs) s.endedTs = Date.now();
    if (!s.ended && s.endedTs) s.endedTs = null;
    if (s.ended) { s.thinking = false; s.agentActive = false; }
    scheduleSnapshot();
    onDetail(detail(s));
    return s;
  }

  function touch(id, fields = {}) {
    return upsert(id, { ...fields, lastActivityTs: Date.now() });
  }

  function get(id) {
    const s = sessions.get(id);
    return s ? detail(s) : null;
  }

  function remove(id) {
    if (sessions.delete(id)) scheduleSnapshot();
  }

  // Ended sessions are worth showing for a while — you want to see what just
  // finished — but not forever, or short-lived one-shot runs pile up.
  function prune() {
    const cutoff = Date.now() - ENDED_TTL_MS;
    let removed = 0;
    for (const [id, s] of sessions) {
      if (s.ended && (s.endedTs || s.lastActivityTs) < cutoff) {
        sessions.delete(id);
        removed++;
      }
    }
    if (removed) scheduleSnapshot();
  }

  // periodic re-derive so celebrate->idle / busy->idle transitions emit
  setInterval(() => { prune(); scheduleSnapshot(); }, 5_000).unref();

  return {
    upsert, touch, get, remove, snapshot,
    count: () => sessions.size,
    raw: (id) => sessions.get(id),
    entries: () => [...sessions.entries()],
    set onSnapshot(fn) { onSnapshot = fn; },
    set onDetail(fn) { onDetail = fn; },
  };
}
