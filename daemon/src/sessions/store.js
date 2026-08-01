// Merged session state + busy/attention/celebrate/idle machine.
// Sources call upsert()/touch()/remove(); the store owns state derivation and
// emits debounced full snapshots via onSnapshot.

import {
  SESSION_CAP, SNAPSHOT_DEBOUNCE_MS, BUSY_WINDOW_MS, CELEBRATE_MS,
  AGENT_ACTIVE_TTL_MS, THINKING_TTL_MS,
} from '../config.js';
import { contextFraction } from '../context-window.js';

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
      // 0..1 of the model's context window, or null when we can't know — the
      // device draws no meter rather than a meter against a guess.
      context: contextFraction(s.model, s.contextTokens),
      pendingPermission: !!s.pendingPermission,
      // Which permission mode the window is in: plan / bypassPermissions /
      // acceptEdits / auto / default. null until something says, and the
      // device draws no badge rather than guessing — older transcripts carry
      // no mode record at all, and "manual" is the wrong guess for a session
      // running with permissions skipped.
      permissionMode: s.permissionMode || null,
      // idle means "nothing recently"; ended means the session is over. The
      // device labels them differently, so both have to travel.
      ended: !!s.ended,
    };
  }

  function detail(s) {
    return {
      ...summary(s),
      contextTokens: s.contextTokens || 0,
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
    // The device knows neither what time it is nor which timezone it is in: no
    // RTC battery, no NTP, no timezone data in the firmware. Both corrections
    // ride every snapshot — serverNowMs sets its epoch (which also fixes the
    // durations and countdowns it works out against Mac-stamped timestamps),
    // tzOffsetMin renders that in Mac-local time. Computed per snapshot rather
    // than once so a DST flip propagates.
    //
    // These travel inside the payload, not as the frame's server_timestamp_ms:
    // nocturned re-stamps relayed frames with the device's own clock.
    return {
      sessions: list,
      stats,
      serverNowMs: Date.now(),
      tzOffsetMin: new Date().getTimezoneOffset(),
    };
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
    Object.assign(s, fields);
    // Every fresh assertion that the session is thinking restamps the clock, so
    // the TTL measures silence since the last proof of life rather than time
    // since the turn began. Stamping only on the false->true edge meant a turn
    // longer than the TTL aged out mid-thought.
    if (fields.thinking) s.thinkingTs = Date.now();
    // An ended session leaves at once rather than sitting out a grace period:
    // it can't be acted on, and a headstone tile reads as a live session. The
    // detail event still goes out, so a device parked on that screen learns the
    // session ended instead of watching a frozen tile.
    if (s.ended) {
      s.thinking = false;
      s.agentActive = false;
      sessions.delete(id);
      scheduleSnapshot();
      onDetail(detail(s));
      return s;
    }
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

  // periodic re-derive so celebrate->idle / busy->idle transitions emit
  setInterval(() => { scheduleSnapshot(); }, 5_000).unref();

  return {
    upsert, touch, get, remove, snapshot,
    count: () => sessions.size,
    raw: (id) => sessions.get(id),
    entries: () => [...sessions.entries()],
    set onSnapshot(fn) { onSnapshot = fn; },
    set onDetail(fn) { onDetail = fn; },
  };
}
