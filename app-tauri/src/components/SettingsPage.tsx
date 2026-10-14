import { useEffect, useState } from "react";
import { toast } from "sonner";
import { appMeta, coreLog, getLastApiError } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Aura } from "@/state/useAura";
import { ArrowLeft, ChevronRight } from "lucide-react";

function planLabel(plan: string) {
  if (plan === "free_trial") return "Free trial";
  if (plan === "standard" || plan === "paid") return "Standard";
  return "No plan";
}

function fmtDate(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function SettingsPage({
  aura,
  onBack,
  onOpenLogs,
}: {
  aura: Aura;
  onBack: () => void;
  onOpenLogs: () => void;
}) {
  const [version, setVersion] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const account = aura.accountStatus;
  const { helper } = aura;

  useEffect(() => {
    appMeta().then((m) => setVersion(m.version)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!confirmSignOut) return;
    const t = setTimeout(() => setConfirmSignOut(false), 3000);
    return () => clearTimeout(t);
  }, [confirmSignOut]);

  async function copyCoreLog() {
    const text = await coreLog().catch(() => "could not read the helper log");
    await navigator.clipboard.writeText(text);
    toast.success("Helper log copied");
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Group title="Account">
          <Row label="Name" value={account?.display_name ?? "—"} />
          <Row label="Plan" value={account ? planLabel(account.plan) : "—"} />
          <Row label="Renews / expires" value={fmtDate(account?.expires_at)} />
          {aura.budgetBytes > 0 && (
            <Row label="Data this month" value={`${fmtBytes(aura.monthUsed)} of ${fmtBytes(aura.budgetBytes)}`} />
          )}
        </Group>

        <Group title="Helper">
          <Row
            label="Status"
            value={
              !helper.installed ? (
                <span className="text-amber-400">Not installed</span>
              ) : helper.outdated ? (
                <span className="text-amber-400">Update available</span>
              ) : (
                <span className="text-emerald-400">Running</span>
              )
            }
          />
          {helper.version && <Row label="Version" value={helper.version} />}
          <div className="flex gap-2 px-3 py-2.5">
            {(!helper.installed || helper.outdated) && (
              <SmallButton primary disabled={aura.helperBusy} onClick={() => aura.installCore()}>
                {aura.helperBusy ? "Working…" : helper.installed ? "Update helper" : "Install helper"}
              </SmallButton>
            )}
            {helper.installed && (
              <SmallButton disabled={aura.helperBusy} onClick={() => aura.uninstallCore()}>
                Uninstall
              </SmallButton>
            )}
          </div>
        </Group>

        <Group title="Tailscale">
          <p className="px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            If Tailscale is running, your tailnet (100.x addresses and MagicDNS) keeps working while Aura is
            connected. Nothing to turn on: Aura leaves Tailscale's traffic alone and, on networks that hijack the
            tailnet range, points it back at Tailscale until you disconnect.
          </p>
          <Row
            label="Right now"
            value={
              aura.phase !== "connected"
                ? "Connect to check"
                : aura.tailscale === "rerouted"
                  ? "Working (route repaired)"
                  : aura.tailscale === "ok"
                    ? "Working"
                    : "Not running"
            }
          />
        </Group>

        <Group title="Diagnostics">
          <NavRow label="App log" onClick={onOpenLogs} />
          <NavRow label="Copy helper log" onClick={copyCoreLog} />
          {aura.debugMode && (
            <div className="px-3 py-2.5 text-xs text-muted-foreground">
              Last API error:{" "}
              <code className="break-all rounded bg-muted px-1 py-0.5 text-[11px]">{getLastApiError() ?? "none"}</code>
            </div>
          )}
        </Group>

        <button
          type="button"
          onClick={() => (confirmSignOut ? aura.logout() : setConfirmSignOut(true))}
          className={cn(
            "mt-2 h-10 w-full rounded-lg border text-sm font-medium transition-colors",
            confirmSignOut
              ? "border-destructive bg-destructive/15 text-destructive"
              : "border-border text-destructive hover:bg-destructive/10",
          )}
        >
          {confirmSignOut ? "Click again to sign out" : "Sign out"}
        </button>

        <p className="mt-4 text-center text-xs text-muted-foreground">Aura {version}</p>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

function NavRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-muted"
    >
      {label}
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function SmallButton({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-8 rounded-md px-3 text-xs font-semibold transition-colors disabled:opacity-60",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
