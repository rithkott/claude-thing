import { RefreshCw } from 'lucide-react';
import { Button, Card, PageHeader, Stat, StatusRow } from '../components/ui';
import { useDaemonLink, useLastPermission, useStatus } from '../hooks';

const TOPICS = ['bridge.clients', 'bridge.connector', 'claude.permission.request', 'claude.permission.resolved'];

export function Dashboard() {
  const { status, error, refresh } = useStatus(TOPICS);
  const linked = useDaemonLink();
  const lastPerm = useLastPermission();

  const connectorOnline = (status?.clients?.connector ?? 0) > 0;
  const deviceOnline = (status?.clients?.emulator ?? 0) > 0 || connectorOnline;
  const bt = status?.connector?.bt;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Backend connection and Car Thing link status."
        action={<Button variant="outline" onClick={refresh}><RefreshCw className="size-3.5" />Refresh</Button>}
      />

      {error && (
        <Card className="mb-4 border-destructive/40">
          <div className="text-sm text-destructive">daemon unreachable — {error}</div>
          <div className="mt-1 text-xs text-muted">start it with <span className="font-mono">npm start</span> in daemon/</div>
        </Card>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-3 gap-6">
          <Stat k="sessions" v={status?.sessions ?? '—'} />
          <Stat k="pending prompts" v={status?.pendingPermissions ?? '—'} />
          <Stat k="daemon" v={status ? `v${status.daemonVersion}` : '—'} />
        </div>
      </Card>

      <Card className="mb-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Backend</div>
        <StatusRow label="Daemon" value={status ? 'running' : 'offline'} tone={status ? 'ok' : 'bad'}
          hint="host daemon on 127.0.0.1:8790" />
        <StatusRow label="Live event stream" value={linked ? 'connected' : 'reconnecting'} tone={linked ? 'ok' : 'warn'}
          hint="this page's WebSocket to the daemon" />
        <StatusRow label="Claude Code hooks" value={status?.hooks ? 'installed' : 'not installed'}
          tone={status?.hooks ? 'ok' : 'warn'} hint="PermissionRequest + lifecycle hooks in ~/.claude/settings.json" />
        <StatusRow label="Session sources" value={status?.sources?.join(', ') || '—'} tone={status ? 'ok' : 'off'} />
      </Card>

      <Card className="mb-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Car Thing link</div>
        <StatusRow label="Nocturne connector" value={connectorOnline ? 'relaying' : 'not connected'}
          tone={connectorOnline ? 'ok' : 'off'} hint="Swift app's claude.* relay over Bluetooth" />
        <StatusRow label="Emulator" value={(status?.clients?.emulator ?? 0) > 0 ? 'attached' : 'not running'}
          tone={(status?.clients?.emulator ?? 0) > 0 ? 'ok' : 'off'} hint="local dev device" />
        <StatusRow label="Device reachable" value={deviceOnline ? 'yes' : 'no'} tone={deviceOnline ? 'ok' : 'bad'} />
        {bt && (
          <StatusRow label="Bluetooth device" value={bt.device || bt.address || 'unknown'}
            tone={bt.connected ? 'ok' : 'warn'} hint={bt.firmware ? `firmware ${bt.firmware}` : undefined} />
        )}
      </Card>

      <Card>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Last permission prompt</div>
        {lastPerm ? (
          <div>
            <div className="font-mono text-sm text-fg">{lastPerm.tool}: {lastPerm.summary}</div>
            <div className="mt-1 text-xs text-muted">
              {lastPerm.resolution ? `resolved: ${lastPerm.resolution}` : 'waiting for an answer on the device…'}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted">nothing yet this session</div>
        )}
      </Card>
    </div>
  );
}
