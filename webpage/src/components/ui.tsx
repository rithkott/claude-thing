import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-lg border border-line bg-raised p-5', className)}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex items-start justify-between">
      <div>
        <h2 className="text-3xl font-semibold tracking-tight text-fg">{title}</h2>
        {subtitle && <p className="mt-2 text-secondary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const DOT: Record<string, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  bad: 'bg-destructive',
  off: 'bg-muted',
};

export function StatusRow({ label, value, tone = 'off', hint }: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'off';
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-line py-3 last:border-0">
      <div>
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      <div className="flex items-center gap-2">
        <span className={clsx('size-2 rounded-full', DOT[tone])} />
        <span className="font-mono text-sm text-secondary">{value}</span>
      </div>
    </div>
  );
}

export function Button({ children, onClick, variant = 'default', disabled }: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'outline' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40',
        variant === 'default' && 'bg-accent text-black hover:bg-accent-hover',
        variant === 'outline' && 'border border-line text-secondary hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border border-destructive text-destructive hover:bg-destructive/10',
      )}
    >
      {children}
    </button>
  );
}

export function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div>
      <div className="font-mono text-2xl text-fg">{v}</div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{k}</div>
    </div>
  );
}
