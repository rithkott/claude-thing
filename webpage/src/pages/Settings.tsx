import { useState } from 'react';
import { Button, Card, PageHeader, StatusRow } from '../components/ui';
import { useStatus } from '../hooks';
import { postApi } from '../ws';

export function Settings() {
  const { status, refresh } = useStatus([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(action: 'install' | 'uninstall') {
    setBusy(true);
    setMsg(null);
    try {
      const out = await postApi(`/api/hooks/${action}`);
      setMsg(out.output || `${action} complete`);
      await refresh();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Claude Code integration and daemon configuration." />

      <Card className="mb-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Claude Code hooks</div>
        <StatusRow label="Hook status" value={status?.hooks ? 'installed' : 'not installed'}
          tone={status?.hooks ? 'ok' : 'warn'}
          hint="PermissionRequest, SessionStart/End, PreToolUse, PostToolUse, Stop, UserPromptSubmit" />
        <div className="mt-4 flex gap-2">
          <Button onClick={() => run('install')} disabled={busy}>Install hooks</Button>
          <Button variant="danger" onClick={() => run('uninstall')} disabled={busy}>Remove hooks</Button>
        </div>
        {msg && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-hover p-3 font-mono text-xs text-secondary">{msg}</pre>}
        <p className="mt-3 text-xs text-muted">
          A backup of ~/.claude/settings.json is written on every change. Hooks only affect Claude Code sessions
          started afterwards, and a missing daemon never blocks Claude Code — prompts fall back to the terminal.
        </p>
      </Card>

      <Card>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Daemon</div>
        <StatusRow label="Version" value={status ? `v${status.daemonVersion}` : '—'} tone={status ? 'ok' : 'off'} />
        <StatusRow label="Port" value="127.0.0.1:8790" tone="ok" hint="loopback only" />
        <StatusRow label="Permission hold" value="55s" tone="ok"
          hint="after this the terminal prompt takes over — the device never auto-denies" />
        <StatusRow label="Session cap on device" value="8 sessions" tone="ok"
          hint="keeps a snapshot under the Bluetooth chunk budget" />
      </Card>
    </div>
  );
}
