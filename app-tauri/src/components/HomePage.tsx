import * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { AuraMark } from "@/components/AuraMark";
import { ServerTile } from "@/components/ServerTile";
import { SettingsSheet } from "@/components/SettingsSheet";
import { fmtBytes } from "@/lib/format";
import * as lines from "@/lib/lines";
import { cn } from "@/lib/utils";
import { AUTO_TAG, type Aura, type Phase } from "@/state/useAura";
import type { ServerInfo } from "@/lib/api";
import {
  CloudDownload,
  Hourglass,
  Lock,
  LogOut,
  Power,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  ArrowUp,
  ArrowDown,
  Router,
  Download,
  Settings2,
  ShieldBan,
  Waypoints,
  Globe,
} from "lucide-react";

const GB = 1024 * 1024 * 1024;
void GB;

function planLabel(plan: string) {
  if (plan === "free_trial") return "FREE TRIAL";
  if (plan === "standard") return "STANDARD";
  return "NONE";
}

const phaseStyle: Record<Phase, { color: string; icon: React.ReactNode; line: string; sub: string }> = {
  loggedOut: {
    color: "text-muted-foreground",
    icon: <Lock className="size-9" />,
    line: lines.pick(lines.loggedOut),
    sub: "log in to unlock the aura",
  },
  disconnected: {
    color: "text-muted-foreground",
    icon: <Power className="size-9" />,
    line: lines.pick(lines.disconnected),
    sub: "tap to ascend",
  },
  fetchingConfig: {
    color: "text-secondary-foreground",
    icon: <CloudDownload className="size-9" />,
    line: "fetching the config...",
    sub: "checking in with api.copal.run",
  },
  connecting: {
    color: "text-secondary-foreground",
    icon: <Hourglass className="size-9" />,
    line: lines.pick(lines.connecting),
    sub: "establishing the tunnel",
  },
  connected: {
    color: "text-primary",
    icon: <ShieldCheck className="size-9" />,
    line: lines.pick(lines.connected),
    sub: "via the aura — 0 down",
  },
  error: {
    color: "text-destructive",
    icon: <TriangleAlert className="size-9" />,
    line: lines.pick(lines.error),
    sub: "something broke fr",
  },
};

export function HomePage({ aura, onOpenLogs }: { aura: Aura; onOpenLogs: () => void }) {
  const { phase, serverConfig, selectedServerTag, activeServer, latencies } = aura;
  const busy = phase === "connecting" || phase === "fetchingConfig";
  const isConnected = phase === "connected";
  const servers = serverConfig?.servers ?? [];
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoServer: ServerInfo = { tag: AUTO_TAG, host: "", ip: "", username: "", password: "" };

  const status = React.useMemo(() => {
    const base = phaseStyle[phase];
    if (phase === "connected") {
      return {
        ...base,
        line: lines.pick(lines.connected, (activeServer ?? "aura").length),
        sub: `via ${activeServer ?? "?"} — ${fmtBytes(aura.downBytes)} down`,
      };
    }
    if (phase === "error") {
      return { ...base, sub: aura.statusLine ?? "something broke fr" };
    }
    return base;
  }, [phase, activeServer, aura.statusLine, aura.egressIp, aura.proxyAddr]);

  return (
    <div className="flex h-screen flex-col bg-background">
      <Header aura={aura} onOpenLogs={onOpenLogs} onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <StatusCard aura={aura} busy={busy} isConnected={isConnected} status={status} />

        <div className="mt-4 flex items-center gap-2">
          <StatChip icon={<ArrowUp className="size-3.5" />} text={fmtBytes(aura.upBytes)} />
          <StatChip icon={<ArrowDown className="size-3.5" />} text={fmtBytes(aura.downBytes)} />
          {activeServer && (
            <StatChip icon={<Router className="size-3.5" />} text={`${activeServer} locked in`} />
          )}
          {aura.proxyAddr && (
            <StatChip icon={<Waypoints className="size-3.5" />} text={`socks5 ${aura.proxyAddr}`} />
          )}
          {aura.egressIp && (
            <StatChip icon={<Globe className="size-3.5" />} text={`egress ${aura.egressIp}`} />
          )}
        </div>

        <BudgetBar aura={aura} />

        <div className="mt-4 flex items-center">
          <h2 className="text-sm font-medium">servers</h2>
          <span className="ml-2 text-xs text-muted-foreground">
            {isConnected ? "locked while connected" : "choose one"}
          </span>
          <button
            type="button"
            onClick={() => aura.refreshConfig()}
            disabled={busy}
            className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="refresh config (bypasses cache)"
          >
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          </button>
        </div>

        {servers.length === 0 ? (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {phase === "error" ? "no config loaded — tap refresh. blame the cloud, not me fr" : "no servers yet — press the big button"}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <ServerTile
              server={autoServer}
              latencyMs={undefined}
              isActive={activeServer === AUTO_TAG}
              isSelected={selectedServerTag === AUTO_TAG}
              locked={isConnected || phase === "connecting"}
              onTap={() => aura.selectServer(AUTO_TAG)}
            />
            {servers.map((s) => (
              <ServerTile
                key={s.tag}
                server={s}
                latencyMs={latencies[s.tag]}
                isActive={activeServer === s.tag}
                isSelected={selectedServerTag === s.tag}
                locked={isConnected || phase === "connecting"}
                onTap={() => aura.selectServer(s.tag)}
              />
            ))}
          </div>
        )}
      </div>

      {aura.blocked && (
        <div className="flex items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-5 py-2.5 text-xs font-medium text-destructive">
          <ShieldBan className="size-4" />
          Kill switch engaged — traffic is blocked. Reconnect or turn it off in settings.
        </div>
      )}

      <SettingsSheet aura={aura} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function Header({
  aura,
  onOpenLogs,
  onOpenSettings,
}: {
  aura: Aura;
  onOpenLogs: () => void;
  onOpenSettings: () => void;
}) {
  const account = aura.accountStatus;
  return (
    <div className="flex items-center gap-2.5 px-5 pb-2 pt-4">
      <div className="flex size-10 items-center justify-center rounded-[13px] bg-primary">
        <AuraMark size={28} color="var(--primary-foreground)" />
      </div>
      <div className="leading-tight">
        <p className="text-base font-black tracking-[0.22em]">AURA</p>
        <p className="text-[10px] font-bold tracking-[0.12em] text-muted-foreground">(v26.1.0)</p>
        {account && (
          <p className="text-[10px] font-extrabold tracking-wide text-primary">
            {planLabel(account.plan)} • {account.budget_gb} GB • {account.display_name}
          </p>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        {aura.updateVersion && (
          <button
            type="button"
            onClick={() => toast.info("auto-update isn't wired into this port yet")}
            className="mr-1 flex items-center gap-1 rounded-lg bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary"
          >
            <Download className="size-3.5" />
            ⬆ {aura.updateVersion}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="tunnel settings"
        >
          <Settings2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => aura.logout()}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="log out"
        >
          <LogOut className="size-4" />
        </button>
        <button
          type="button"
          onClick={onOpenLogs}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="logs"
        >
          <span className="font-mono text-xs font-bold">›_</span>
        </button>
      </div>
    </div>
  );
}

function StatusCard({
  aura,
  busy,
  isConnected,
  status,
}: {
  aura: Aura;
  busy: boolean;
  isConnected: boolean;
  status: { color: string; icon: React.ReactNode; line: string; sub: string };
}) {
  return (
    <div className="relative mt-2 overflow-hidden rounded-3xl border border-border/80 bg-gradient-to-br from-muted/40 to-card p-6 text-center shadow-2xl">
      <div
        className="pointer-events-none absolute inset-0 opacity-40 blur-3xl"
        style={{
          background: `radial-gradient(circle at 50% 0%, var(--color-muted-foreground), transparent 70%)`,
        }}
      />
      <div className="relative">
        <ConnectButton aura={aura} busy={busy} isConnected={isConnected} status={status} />
        <p className={cn("mt-4 text-sm font-bold", status.color)}>{status.line}</p>
        <p className="mt-1 text-xs text-muted-foreground">{status.sub}</p>
      </div>
    </div>
  );
}

function ConnectButton({
  aura,
  busy,
  isConnected,
  status,
}: {
  aura: Aura;
  busy: boolean;
  isConnected: boolean;
  status: { color: string; icon: React.ReactNode; line: string; sub: string };
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => (isConnected ? aura.disconnect() : aura.connect())}
      className={cn(
        "mx-auto flex size-[92px] items-center justify-center rounded-full border-2 bg-transparent transition-all duration-300 focus:outline-none",
        `${status.color}`,
        "border-current",
        busy && "cursor-not-allowed opacity-80",
      )}
      style={{ boxShadow: "0 0 26px 0 color-mix(in oklch, currentColor 24%, transparent)" }}
    >
      <span className={cn(status.color)}>
        {busy ? (
          <span className="block size-9 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          isConnected ? <Power className="size-9" /> : status.icon
        )}
      </span>
    </button>
  );
}

function StatChip({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="text-foreground/70">{icon}</span>
      {text}
    </span>
  );
}

function BudgetBar({ aura }: { aura: Aura }) {
  if (aura.budgetBytes === 0) return null;
  const frac = Math.max(0, Math.min(1, aura.budgetFraction));
  const color = aura.overBudget
    ? "text-destructive"
    : aura.budgetWarn
      ? "text-amber-400"
      : "text-primary";
  const barColor = aura.overBudget
    ? "var(--color-destructive)"
    : aura.budgetWarn
      ? "oklch(0.78 0.15 85)" // amber
      : "var(--color-primary)";
  const line = aura.overBudget
    ? lines.pick(lines.budgetOver)
    : aura.budgetWarn
      ? lines.pick(lines.budgetLow)
      : lines.pick(lines.budget);
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5">
        <span className={cn("text-xs text-muted-foreground")}>{fmtBytes(aura.monthUsed)} / {fmtBytes(aura.budgetBytes)} this month</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full rounded transition-all duration-300"
          style={{ width: `${frac * 100}%`, background: barColor }}
        />
      </div>
      <p className={cn("mt-1.5 text-[11px]", color)}>{line}</p>
    </div>
  );
}
