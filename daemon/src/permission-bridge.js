// Holds Claude Code PermissionRequest hook HTTP responses until a device
// answers or PERMISSION_HOLD_MS elapses. Never auto-denies: timeout answers
// behavior:"ask" so the normal terminal prompt takes over.

import crypto from 'node:crypto';
import { PERMISSION_HOLD_MS } from './config.js';
import { log } from './log.js';

export function createPermissionBridge({ emit, store, queue }) {
  const pending = new Map(); // requestId -> {res, timer, sessionId}

  function hookDecision(behavior) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior },
      },
    });
  }

  // The device renders the tool name separately, so the summary is just the
  // salient argument.
  function summarizeTool(toolName, toolInput) {
    if (!toolInput) return toolName;
    const known = toolInput.command || toolInput.file_path || toolInput.url ||
      toolInput.path || toolInput.pattern;
    if (known) return String(known).slice(0, 200);
    // A tool we have no salient key for still has to read as English on a
    // 800x480 screen. Stringifying the whole input put a truncated blob of
    // JSON in the card body, so prefer any string field, then the key names.
    const text = Object.values(toolInput).find((v) => typeof v === 'string' && v.trim());
    if (text) return text.slice(0, 200);
    const keys = Object.keys(toolInput);
    return keys.length ? keys.join(', ').slice(0, 200) : toolName;
  }

  function finish(requestId, resolution, behavior) {
    const p = pending.get(requestId);
    if (!p) return false;
    pending.delete(requestId);
    clearTimeout(p.timer);
    try {
      p.res.writeHead(200, { 'Content-Type': 'application/json' });
      p.res.end(behavior ? hookDecision(behavior) : hookDecision('ask'));
    } catch {}
    if (p.sessionId) {
      store.upsert(p.sessionId, { pendingPermission: false, permission: null });
    }
    emit('claude.permission.resolved', { requestId, resolution });
    log('PB', `permission ${requestId} -> ${resolution}`);
    return true;
  }

  // Called by http-server with the parsed hook payload + held response object.
  function onHookRequest(payload, res) {
    // Two tools are dialogs, not permissions, and both already reach the
    // device through the question queue:
    //   • ExitPlanMode — Claude Code ignores the decision for it and keeps its
    //     dialog up (verified v2.1.220), so holding only makes the tile lie.
    //     The plan is surfaced here, since no other hook carries it.
    //   • AskUserQuestion — the PreToolUse hook already queued the real
    //     multiple-choice card (sessions/source-hooks.js). Holding a
    //     permission for the same call put a second card on the device whose
    //     body was the stringified questions array, and denying it killed the
    //     question before the user could answer the card that mattered.
    // Both answer "ask" at once and leave the interaction to the question path.
    if (queue && (payload.tool_name === 'ExitPlanMode' || payload.tool_name === 'AskUserQuestion')) {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(hookDecision('ask'));
      } catch {}
      // Only the plan needs queueing — re-queueing the question here would
      // duplicate the PreToolUse ask under a second id.
      if (payload.tool_name === 'ExitPlanMode') queue.onPlanApproval(payload);
      return;
    }

    const requestId = crypto.randomUUID();
    const sessionId = payload.session_id || null;
    const tool = payload.tool_name || 'unknown';
    const summary = summarizeTool(tool, payload.tool_input);
    const createdTs = Date.now();

    const timer = setTimeout(() => finish(requestId, 'timeout', 'ask'), PERMISSION_HOLD_MS);
    timer.unref();
    pending.set(requestId, { res, timer, sessionId, tool, summary, createdTs });
    res.on('close', () => {
      // hook side gave up (Claude Code timeout / session killed)
      if (pending.has(requestId)) {
        pending.delete(requestId);
        clearTimeout(timer);
        if (sessionId) store.upsert(sessionId, { pendingPermission: false, permission: null });
        emit('claude.permission.resolved', { requestId, resolution: 'timeout' });
      }
    });

    const permission = { requestId, tool, summary, createdTs, timeoutMs: PERMISSION_HOLD_MS };
    if (sessionId) {
      store.touch(sessionId, {
        pendingPermission: true,
        permission,
        cwd: payload.cwd || undefined,
        currentTool: tool,
      });
    }
    emit('claude.permission.request', { ...permission, sessionId });
    log('PB', `permission held: ${summary} (${requestId})`);
  }

  function answer(requestId, decision) {
    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('decision must be allow|deny');
    }
    return finish(requestId, decision, decision);
  }

  // Pending permissions as queue entries, for clients that connect late.
  function list() {
    return [...pending.entries()].map(([id, p]) => ({
      kind: 'permission',
      id,
      sessionId: p.sessionId,
      sessionName: p.sessionId && store.get(p.sessionId) ? store.get(p.sessionId).name : 'session',
      tool: p.tool,
      summary: p.summary,
      createdTs: p.createdTs,
      timeoutMs: PERMISSION_HOLD_MS,
    })).sort((a, b) => a.createdTs - b.createdTs);
  }

  return { onHookRequest, answer, list, pendingCount: () => pending.size };
}
