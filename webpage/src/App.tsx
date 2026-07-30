import { useEffect } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Bluetooth, LayoutDashboard, Settings as SettingsIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { Dashboard } from './pages/Dashboard';
import { Bluetooth as BluetoothPage } from './pages/Bluetooth';
import { Settings } from './pages/Settings';
import { connect } from './ws';
import { useDaemonLink } from './hooks';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/bluetooth', label: 'Bluetooth', icon: Bluetooth },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function Nav() {
  const loc = useLocation();
  return (
    <nav className="flex items-center gap-1">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to);
        return (
          <NavLink key={to} to={to} className={clsx(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            active ? 'bg-hover text-fg' : 'text-secondary hover:bg-hover hover:text-fg',
          )}>
            <Icon className="size-4" />
            {label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const linked = useDaemonLink();
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="size-2.5 rounded-sm bg-accent" />
            <span className="text-sm font-semibold tracking-[0.18em] text-secondary">CLAUDE THING</span>
          </div>
          <Nav />
          <span className={clsx('size-2 rounded-full', linked ? 'bg-success' : 'bg-destructive')}
            title={linked ? 'daemon connected' : 'daemon offline'} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t border-line px-6 py-4 text-center text-xs text-muted">
        Car Thing session monitor · Nocturne extension
      </footer>
    </div>
  );
}

export default function App() {
  useEffect(() => { connect(); }, []);
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bluetooth" element={<BluetoothPage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
