import { useCallback, useEffect, useState } from 'react';
import { getStatus, onConnection, onTopic } from './ws';

export type Status = {
  daemonVersion: string;
  sessions: number;
  pendingPermissions: number;
  clients: Record<string, number>;
  connector: null | {
    bt?: { connected?: boolean; device?: string; address?: string; serial?: string; firmware?: string };
    updatedTs?: number;
  };
  sources: string[];
  hooks: boolean;
};

// Polls /status and refreshes immediately on any daemon event, mirroring the
// connector client's useAutoRefresh pattern.
export function useStatus(refreshTopics: string[] = []) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus());
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    const offs = refreshTopics.map((topic) => onTopic(topic, () => refresh()));
    return () => {
      clearInterval(t);
      offs.forEach((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshTopics.join(',')]);

  return { status, error, refresh };
}

export function useDaemonLink() {
  const [connected, setConnected] = useState(false);
  useEffect(() => onConnection(setConnected), []);
  return connected;
}

export function useLastPermission() {
  const [last, setLast] = useState<{ summary: string; tool: string; resolution?: string; ts: number } | null>(null);
  useEffect(() => {
    const a = onTopic('claude.permission.request', (d) =>
      setLast({ summary: d.summary, tool: d.tool, ts: Date.now() }));
    const b = onTopic('claude.permission.resolved', (d) =>
      setLast((prev) => (prev ? { ...prev, resolution: d.resolution, ts: Date.now() } : prev)));
    return () => { a(); b(); };
  }, []);
  return last;
}
