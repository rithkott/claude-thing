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
    const t = toolInput.command || toolInput.file_path || toolInput.url ||
      toolInput.path || toolInput.pattern || JSON.stringify(toolInput);
    return String(t).slice(0, 200);
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
    // Plan approval is not answerable through this hook: Claude Code ignores
    // the decision for ExitPlanMode and keeps its dialog up (verified
    // v2.1.220), so holding the request only makes the device tile lie.
    // Answer "ask" immediately and surface the plan as a question instead.
    if (queue && payload.tool_name === 'ExitPlanMode') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(hookDecision('ask'));
      } catch {}
      queue.onPlanApproval(payload);
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
