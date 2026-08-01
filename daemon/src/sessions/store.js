// Merged session state + busy/attention/celebrate/idle machine.
// Sources call upsert()/touch()/remove(); the store owns state derivation and
// emits debounced full snapshots via onSnapshot.

import {
  SESSION_CAP, SNAPSHOT_DEBOUNCE_MS, BUSY_WINDOW_MS, CELEBRATE_MS,
  AGENT_ACTIVE_TTL_MS, THINKING_TTL_MS, DETAIL_DEBOUNCE_MS, SNAPSHOT_HEARTBEAT_MS,
} from '../config.js';
import { contextFraction } from '../context-window.js';

export function createStore() {
  const sessions = new Map(); // id -> internal record
  let wakeCounter = 0;        // strictly increasing wake order for live sessions
  let snapshotTimer = null;
  let onSnapshot = () => {};
  let onDetail = () => {};
  const detailTimers = new Map(); // id -> trailing debounce timer
  let lastSnapshotKey = '';       // sessions+stats of the last emitted snapshot
  let lastSnapshotTs = 0;

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

  // Ordering by raw activity alone made the list thrash: every hook fire on any
  // live session bounced it to the front, so a screen with three working
  // sessions reshuffled every few seconds and the tile you were reaching for
  // moved out from under your finger. A session may now only overtake *idle*
  // sessions. Live ones hold the order they woke up in — the mark is taken on
  // the idle->live edge and then left alone however much the session works —
  // and idle ones stay newest-first behind them. The mark is a counter rather
  // than a clock because several sessions can wake inside one millisecond and
  // still need a definite order between them.
  function markWake(s, state) {
    if (state === 'idle') s.wakeSeq = 0;
    else if (!s.wakeSeq) s.wakeSeq = ++wakeCounter;
  }

  function snapshot(limit) {
    const rows = [...sessions.values()].map((s) => {
      const view = summary(s);
      markWake(s, view.state);
      return { s, view };
    });
    rows.sort((a, b) => {
      const aIdle = a.view.state === 'idle';
      const bIdle = b.view.state === 'idle';
      if (aIdle !== bIdle) return aIdle ? 1 : -1;
      if (!aIdle) return a.s.wakeSeq - b.s.wakeSeq;
      return b.view.lastActivityTs - a.view.lastActivityTs;
    });
    const cap = limit || SESSION_CAP;   // 0 = unbounded
    const list = (cap > 0 ? rows.slice(0, cap) : rows).map((r) => r.view);
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
      const snap = snapshot();
      // serverNowMs is excluded from the key — it changes every time and would
      // defeat the comparison; tzOffsetMin stays in so a DST flip still emits.
      const key = JSON.stringify([snap.sessions, snap.stats, snap.tzOffsetMin]);
      const now = Date.now();
      if (key === lastSnapshotKey && now - lastSnapshotTs < SNAPSHOT_HEARTBEAT_MS) return;
      lastSnapshotKey = key;
      lastSnapshotTs = now;
      onSnapshot(snap);
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  // One trailing timer per session: however many writes land inside the window,
  // one detail goes out carrying the state as of the emit. Detail is rebuilt at
  // fire time, not capture time, so it is never stale.
  function scheduleDetail(id) {
    if (detailTimers.has(id)) return;
    const t = setTimeout(() => {
      detailTimers.delete(id);
      const s = sessions.get(id);
      if (s) onDetail(detail(s));
    }, DETAIL_DEBOUNCE_MS);
    if (t.unref) t.unref();
    detailTimers.set(id, t);
  }

  function cancelDetail(id) {
    const t = detailTimers.get(id);
    if (t) { clearTimeout(t); detailTimers.delete(id); }
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
      // The farewell goes out now, not debounced: the record is already gone,
      // so a trailing timer would find nothing and the device would never
      // learn the session ended.
      cancelDetail(id);
      scheduleSnapshot();
      onDetail(detail(s));
      return s;
    }
    scheduleSnapshot();
    scheduleDetail(id);
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
    cancelDetail(id);
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
