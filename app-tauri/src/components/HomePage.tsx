import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { AuraMark } from "@/components/AuraMark";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AUTO_TAG, type Aura, type Phase } from "@/state/useAura";
import {
  Check,
  Download,
  Loader2,
  RefreshCw,
  Settings,
  Sparkles,
  TriangleAlert,
  Waypoints,
} from "lucide-react";

const STATUS: Record<Phase, { label: string; dot: string }> = {
  loggedOut: { label: "Signed out", dot: "bg-muted-foreground" },
  disconnected: { label: "Disconnected", dot: "bg-muted-foreground" },
  fetchingConfig: { label: "Loading", dot: "bg-amber-400 animate-pulse" },
  connecting: { label: "Connecting", dot: "bg-amber-400 animate-pulse" },
  connected: { label: "Connected", dot: "bg-primary" },
  error: { label: "Not connected", dot: "bg-destructive" },
};

function serverName(tag: string) {
  if (tag === AUTO_TAG) return "Automatic";
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function HomePage({
  aura,
  onOpenSettings,
  onDebug,
}: {
  aura: Aura;
  onOpenSettings: () => void;
  onDebug: () => void;
}) {
  const { phase, serverConfig, selectedServerTag, activeServer, latencies } = aura;
  const busy = phase === "connecting" || phase === "fetchingConfig";
  const connected = phase === "connected";
  const servers = serverConfig?.servers ?? [];

  // Space toggles the connection from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
      e.preventDefault();
      if (connected) void aura.disconnect();
      else if (!busy) void aura.connect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aura, connected, busy]);

  const logoClicks = useRef(0);
  const pressLogo = () => {
    logoClicks.current += 1;
    if (logoClicks.current >= 5) {
      logoClicks.current = 0;
      onDebug();
    }
  };

  const status = STATUS[phase];
  const latency = activeServer ? latencies[activeServer] : undefined;
  const detail = connected
    ? [latency !== undefined && `${latency} ms`, `↓ ${fmtBytes(aura.downBytes)}`, `↑ ${fmtBytes(aura.upBytes)}`]
        .filter(Boolean)
        .join(" · ")
    : phase === "error"
      ? aura.statusLine ?? "Something went wrong."
      : busy
        ? phase === "connecting"
          ? "Setting up the tunnel…"
          : "Loading your servers…"
        : "Your traffic isn't protected.";

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <button type="button" onClick={pressLogo} className="flex items-center gap-2" title="Aura">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary">
            <AuraMark size={16} color="var(--primary-foreground)" />
          </span>
          <span className="text-sm font-semibold">Aura</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          {aura.updateVersion && (
            <button
              type="button"
              onClick={() => toast.info(`${aura.updateVersion} is out — download it from api.copal.run/archive`)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
            >
              <Download className="size-3.5" />
              Update
            </button>
          )}
          <IconButton title="Settings" onClick={onOpenSettings}>
            <Settings className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Status */}
        <section className="px-4 pb-4 pt-5">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", status.dot)} />
            <span className="text-base font-semibold">
              {status.label}
              {connected && activeServer && (
                <span className="text-muted-foreground"> · {serverName(activeServer)}</span>
              )}
            </span>
          </div>
          <p
            className={cn(
              "mt-1 min-h-5 text-sm",
              phase === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {detail}
          </p>

          <button
            type="button"
            disabled={busy}
            onClick={() => (connected ? aura.disconnect() : aura.connect())}
            className={cn(
              "mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed",
              connected
                ? "border border-border bg-card text-foreground hover:bg-muted"
                : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-70",
            )}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {connected ? "Disconnect" : busy ? "Connecting" : phase === "error" ? "Try again" : "Connect"}
          </button>

          <Usage aura={aura} />
        </section>

        <Notices aura={aura} />

        {/* Servers */}
        <section className="border-t border-border/60 px-2 pb-3 pt-2">
          <div className="flex items-center px-2 py-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Servers</h2>
            <IconButton
              title="Refresh servers"
              className="ml-auto"
              disabled={busy}
              onClick={() => aura.refreshConfig()}
            >
              <RefreshCw className={cn("size-3.5", phase === "fetchingConfig" && "animate-spin")} />
            </IconButton>
          </div>
          {servers.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {phase === "fetchingConfig" ? "Loading…" : "No servers loaded yet."}
            </p>
          ) : (
            <ul className="flex flex-col">
              {[AUTO_TAG, ...servers.map((s) => s.tag)].map((tag) => (
                <ServerRow
                  key={tag}
                  tag={tag}
                  latency={tag === AUTO_TAG ? undefined : latencies[tag]}
                  selected={selectedServerTag === tag}
                  active={connected && activeServer === tag}
                  disabled={busy}
                  onSelect={() => aura.selectServer(tag)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Footer */}
      <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border/60 px-4 text-xs text-muted-foreground">
        <TailscaleBadge state={aura.tailscale} connected={connected} />
        <span className="ml-auto">Space to {connected ? "disconnect" : "connect"}</span>
      </footer>
    </div>
  );
}

function ServerRow({
  tag,
  latency,
  selected,
  active,
  disabled,
  onSelect,
}: {
  tag: string;
  latency: number | undefined;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const auto = tag === AUTO_TAG;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "flex h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
          selected && "bg-muted",
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
            auto ? "bg-primary/15 text-primary" : "bg-secondary text-secondary-foreground",
          )}
        >
          {auto ? <Sparkles className="size-3.5" /> : tag.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {serverName(tag)}
          {auto && <span className="text-muted-foreground"> · fastest</span>}
        </span>
        {active && <span className="text-xs font-medium text-primary">Connected</span>}
        {latency !== undefined && (
          <span className={cn("w-12 text-right text-xs tabular-nums", latencyColor(latency))}>{latency} ms</span>
        )}
        <span className="flex w-4 justify-end">
          {selected && <Check className="size-4 text-primary" />}
        </span>
      </button>
    </li>
  );
}

function latencyColor(ms: number) {
  if (ms < 120) return "text-emerald-400";
  if (ms < 250) return "text-amber-400";
  return "text-red-400";
}

function Usage({ aura }: { aura: Aura }) {
  if (aura.budgetBytes === 0) return null;
  const frac = Math.max(0, Math.min(1, aura.budgetFraction));
  const bar = aura.overBudget ? "bg-destructive" : aura.budgetWarn ? "bg-amber-400" : "bg-primary";
  return (
    <div className="mt-4">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Data this month</span>
        <span className="tabular-nums">
          {fmtBytes(aura.monthUsed)} of {fmtBytes(aura.budgetBytes)}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function Notices({ aura }: { aura: Aura }) {
  const { helper } = aura;
  if (!helper.installed) {
    return (
      <Notice
        text="The Aura helper isn't installed. It runs the tunnel and needs admin rights once."
        action={aura.helperBusy ? "Installing…" : "Install"}
        disabled={aura.helperBusy}
        onAction={() => aura.installCore()}
      />
    );
  }
  if (helper.outdated) {
    return (
      <Notice
        text={`The helper is out of date (${helper.version} → ${helper.bundled_version}). Update for Tailscale support and fixes.`}
        action={aura.helperBusy ? "Updating…" : "Update"}
        disabled={aura.helperBusy}
        onAction={() => aura.installCore()}
      />
    );
  }
  return null;
}

function Notice({
  text,
  action,
  disabled,
  onAction,
}: {
  text: string;
  action: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="mx-4 mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <p className="flex-1 text-foreground/90">{text}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={onAction}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 font-semibold text-primary-foreground disabled:opacity-60"
      >
        {action}
      </button>
    </div>
  );
}

function TailscaleBadge({ state, connected }: { state: string; connected: boolean }) {
  if (!connected || !state) return <span />;
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        state === "rerouted"
          ? "This network was sending tailnet traffic to its own router. Aura pointed it back at Tailscale while connected."
          : "Tailnet traffic stays on Tailscale while Aura is connected."
      }
    >
      <Waypoints className="size-3.5 text-primary" />
      Tailscale working alongside
    </span>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}
