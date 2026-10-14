import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AuraMark } from '@/components/aura-mark';

interface AdminAccount {
  id: string;
  name: string;
  username: string;
  created_at: number;
  expires_at: number;
  budget_gb: number;
  disabled: boolean;
  source: string;
  plan: string;
  active_sessions: number;
}

async function api<T = unknown>(path: string, opts?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  try {
    const res = await fetch(path, opts);
    const body = await res.json();
    return { ok: res.ok, status: res.status, body };
  } catch {
    // Keep the login/panel error handling simple; the page surfaces a message.
    return { ok: false, status: 0, body: { error: 'network_error' } as T };
  }
}

function fmtDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusPill({ account }: { account: AdminAccount }) {
  const now = Math.floor(Date.now() / 1000);
  const expired = account.expires_at > 0 && account.expires_at <= now;
  const noCredit = account.expires_at === 0;
  const daysLeft = account.expires_at > now ? Math.floor((account.expires_at - now) / 86400) : 0;

  if (account.disabled) return <Badge variant="secondary" className="bg-destructive/15 text-destructive">disabled</Badge>;
  if (expired) return <Badge variant="secondary" className="bg-destructive/15 text-destructive">expired</Badge>;
  if (noCredit) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-500">no credit</Badge>;
  if (daysLeft > 0) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-500">{daysLeft}d left</Badge>;
  return <Badge>active</Badge>;
}

function LoginView({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await onLogin(password);
    } catch {
      setError('Wrong password, duh.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-4 pt-[18vh]">
      <Card>
        <CardHeader className="text-center">
          <AuraMark className="mx-auto" />
          <CardTitle className="text-xl mt-2">
            Aura<span className="text-primary">.</span>
          </CardTitle>
          <CardDescription>admin</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <input
              type="password"
              value={password}
              autoFocus
              placeholder="Admin password"
              className="input"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {error && <div className="text-sm text-destructive">{error}</div>}
            <Button className="w-full" onClick={submit} disabled={busy || !password}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ReleaseUpload({ onToast }: { onToast: (msg: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(key?: string) {
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (key) fd.append('key', key);
    if (version.trim() && !key) fd.append('version', version.trim());
    setBusy(true);
    setError('');
    const r = await api<{ url?: string }>('/v1/admin/release', { method: 'POST', body: fd });
    setBusy(false);
    if (r.ok) {
      onToast('Live at ' + (r.body.url ?? '/dl/latest'));
      setFile(null);
      setVersion('');
    } else {
      setError('Failed: ' + ((r.body as { error?: string }).error ?? r.status));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Publish a build</CardTitle>
        <CardDescription>Upload the Windows release or the source archive.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".zip,application/zip" className="input max-w-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <input
            type="text"
            value={version}
            placeholder="version (e.g. v26.0.2)"
            className="input max-w-[180px]"
            onChange={(e) => setVersion(e.target.value)}
          />
          <Button onClick={() => upload()} disabled={busy}>{busy ? 'Uploading…' : 'Upload release'}</Button>
          <Button variant="outline" asChild>
            <a href="/dl/latest" target="_blank" rel="noreferrer">↗ win</a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/dl/latest-macos" target="_blank" rel="noreferrer">↗ mac</a>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".zip,application/zip" className="input max-w-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button variant="outline" onClick={() => upload('source')} disabled={busy}>
            {busy ? 'Publishing…' : 'Publish source'}
          </Button>
          <Button variant="outline" asChild>
            <a href="/dl/source" target="_blank" rel="noreferrer">↗ src</a>
          </Button>
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}

function DiscordCommands({ onToast }: { onToast: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function register() {
    setBusy(true);
    setError('');
    const r = await api<{ registered?: number; error?: string }>('/v1/admin/commands', { method: 'POST' });
    setBusy(false);
    if (r.ok) onToast(`Registered ${r.body.registered} Discord commands`);
    else setError('Failed: ' + (r.body.error ?? r.status));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Discord commands</CardTitle>
        <CardDescription>Push the bot's slash commands (like /license) to the Aura server. Safe to run any time.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={register} disabled={busy}>{busy ? 'Registering…' : 'Register commands'}</Button>
        {error && <div className="text-sm text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}

function AccountsTable({
  accounts,
  onRefresh,
  onToast,
}: {
  accounts: AdminAccount[];
  onRefresh: () => void;
  onToast: (msg: string) => void;
}) {
  async function act(id: string, action: string, payload: Record<string, unknown>, okMsg: string) {
    const r = await api(`/v1/admin/accounts/${id}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      onToast(okMsg);
      onRefresh();
    } else {
      onToast('Failed: ' + ((r.body as { error?: string }).error ?? r.status));
    }
  }

  async function del(a: AdminAccount) {
    if (!window.confirm(`Delete account "${a.name}" (${a.id})?\nThis kills its live sessions and cannot be undone.`)) return;
    const r = await api(`/v1/admin/accounts/${a.id}`, { method: 'DELETE' });
    if (r.ok) {
      onToast('Account deleted');
      onRefresh();
    } else {
      onToast('Delete failed: ' + ((r.body as { error?: string }).error ?? r.status));
    }
  }

  function setBudget(a: AdminAccount) {
    const v = window.prompt(`Budget GB for ${a.name} (${a.id}):`, String(a.budget_gb));
    if (v === null) return;
    const n = Number(v);
    if (!(n > 0)) {
      onToast('Budget must be a positive number');
      return;
    }
    act(a.id, '/budget', { budget_gb: n }, 'Budget set');
  }

  if (accounts.length === 0) {
    return <div className="text-sm text-muted-foreground py-4">No accounts yet.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground border-b">
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">ID</th>
            <th className="py-2 pr-3 font-medium">Created</th>
            <th className="py-2 pr-3 font-medium">Expires</th>
            <th className="py-2 pr-3 font-medium">Budget</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Live</th>
            <th className="py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} className="border-b last:border-0">
              <td className="py-2 pr-3">
                {a.name}
                {a.source === 'self' && <span className="ml-2 text-[10px] text-muted-foreground">self</span>}
              </td>
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{a.id}</td>
              <td className="py-2 pr-3 text-muted-foreground">{fmtDate(a.created_at)}</td>
              <td className="py-2 pr-3">{fmtDate(a.expires_at)}</td>
              <td className="py-2 pr-3">{a.budget_gb} GB</td>
              <td className="py-2 pr-3"><StatusPill account={a} /></td>
              <td className="py-2 pr-3">{a.active_sessions}</td>
              <td className="py-2">
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => act(a.id, '/extend', { days: 30 }, 'Extended +30d')}>+30d</Button>
                  <Button
                    variant={a.disabled ? 'outline' : 'outline'}
                    className={cn(a.disabled ? '' : 'border-destructive/40 text-destructive hover:bg-destructive/10')}
                    size="sm"
                    onClick={() => act(a.id, a.disabled ? '/enable' : '/disable', {}, a.disabled ? 'Enabled' : 'Disabled')}
                  >
                    {a.disabled ? 'Enable' : 'Disable'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setBudget(a)}>Budget</Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => del(a)}>Delete</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [toast, setToast] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const loadAccounts = useCallback(async () => {
    const r = await api<{ accounts: AdminAccount[] }>('/v1/admin/accounts');
    if (!r.ok) {
      if (r.status === 401) setAuthed(false);
      return;
    }
    setAccounts(r.body.accounts ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api('/v1/admin/me');
      if (r.ok) {
        setAuthed(true);
        await loadAccounts();
      } else {
        setAuthed(false);
      }
    })();
  }, [loadAccounts]);

  async function login(password: string) {
    const r = await api('/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) throw new Error('forbidden');
    setAuthed(true);
    await loadAccounts();
  }

  async function logout() {
    await api('/v1/admin/logout', { method: 'POST' });
    setAuthed(false);
  }

  if (authed === null) {
    return <div className="mx-auto max-w-sm px-4 pt-[18vh]"><Card><CardContent className="p-6 text-sm text-muted-foreground">Checking…</CardContent></Card></div>;
  }

  if (!authed) return <LoginView onLogin={login} />;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-16">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AuraMark />
          <div>
            <h1 className="text-2xl font-bold">
              Aura<span className="text-primary">.</span> <span className="font-normal text-muted-foreground">admin</span>
            </h1>
            <div className="text-sm text-muted-foreground">Discord accounts · sessions · downloads</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadAccounts}>Refresh</Button>
          <Button variant="outline" size="sm" onClick={logout}>Log out</Button>
        </div>
      </header>

      <div className="mt-6 space-y-6">
        <ReleaseUpload onToast={showToast} />
        <DiscordCommands onToast={showToast} />
        <Card>
          <CardContent className="p-5">
            <AccountsTable accounts={accounts} onRefresh={loadAccounts} onToast={showToast} />
          </CardContent>
        </Card>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
