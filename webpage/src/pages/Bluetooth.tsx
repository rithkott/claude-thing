import { Bluetooth as BtIcon } from 'lucide-react';
import { Card, PageHeader, StatusRow } from '../components/ui';
import { useStatus } from '../hooks';

const TOPICS = ['bridge.connector', 'bridge.clients'];

export function Bluetooth() {
  const { status } = useStatus(TOPICS);
  const connector = status?.connector;
  const bt = connector?.bt;
  const relaying = (status?.clients?.connector ?? 0) > 0;

  return (
    <div>
      <PageHeader
        title="Bluetooth"
        subtitle="Verify the Car Thing link. Pairing itself happens in the Nocturne app and macOS System Settings."
      />

      <Card className="mb-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Link state</div>
        <StatusRow label="Nocturne connector relay" value={relaying ? 'connected to daemon' : 'not connected'}
          tone={relaying ? 'ok' : 'off'}
          hint="the Swift app opens this when Claude relay is enabled in its settings" />
        <StatusRow label="Bluetooth session" value={bt?.connected ? 'connected' : bt ? 'idle' : 'unknown'}
          tone={bt?.connected ? 'ok' : bt ? 'warn' : 'off'}
          hint="RFCOMM channel 2, dialed by the Mac after the device probes channel 3" />
        <StatusRow label="Device" value={bt?.device || '—'} tone={bt?.device ? 'ok' : 'off'} />
        <StatusRow label="Address" value={bt?.address || '—'} tone={bt?.address ? 'ok' : 'off'} />
        <StatusRow label="Serial" value={bt?.serial || '—'} tone={bt?.serial ? 'ok' : 'off'} />
        <StatusRow label="Firmware" value={bt?.firmware || '—'} tone={bt?.firmware ? 'ok' : 'off'} />
        <StatusRow label="Last heartbeat" value={connector?.updatedTs ? new Date(connector.updatedTs).toLocaleTimeString() : '—'}
          tone={connector?.updatedTs ? 'ok' : 'off'} hint="connector pushes status every 10s" />
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-fg">
          <BtIcon className="size-4" /> If the device is not connecting
        </div>
        <ol className="space-y-2 text-sm text-secondary">
          <li>1. Pair the Car Thing in macOS System Settings → Bluetooth (the app never drives pairing).</li>
          <li>2. Open the Nocturne app and enable the Claude relay in its Settings.</li>
          <li>3. On the device, hold preset 1 + preset 4 for one second to switch into Claude mode.</li>
          <li>4. Watch this page — the relay row turns green once the connector reaches the daemon.</li>
        </ol>
      </Card>
    </div>
  );
}
