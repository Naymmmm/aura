import { Shield, Bolt, Lock, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AUTO_TAG } from "@/state/useAura";
import type { ServerInfo } from "@/lib/api";

function latencyColor(ms: number) {
  if (ms < 120) return "text-emerald-400";
  if (ms < 250) return "text-amber-400";
  return "text-red-400";
}

export function ServerTile({
  server,
  latencyMs,
  isActive,
  isSelected,
  locked,
  onTap,
}: {
  server: ServerInfo;
  latencyMs: number | undefined;
  isActive: boolean;
  isSelected: boolean;
  locked: boolean;
  onTap?: () => void;
}) {
  const isAuto = server.tag === AUTO_TAG;
  const label = isAuto
    ? "Automatic"
    : server.tag.charAt(0).toUpperCase() + server.tag.slice(1);
  const subtitle = isAuto ? "Auto select the best server" : server.host;
  const active = isActive || isSelected;

  return (
    <button
      type="button"
      disabled={locked}
      onClick={onTap}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-all duration-200",
        isActive
          ? "border-primary/70 bg-primary/10"
          : isSelected
            ? "border-primary/50 bg-muted"
            : "border-border/60 bg-card",
        locked && "cursor-not-allowed opacity-70",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          isAuto ? "bg-accent" : "bg-primary/15",
        )}
      >
        {isAuto ? (
          <Sparkles className="size-4 text-accent-foreground" />
        ) : (
          <Shield className="size-4 text-primary" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {active && (
            <span className="rounded-md bg-primary px-1.5 py-0.5 text-[9px] font-extrabold tracking-wide text-primary-foreground">
              {isActive ? "CONNECTED" : "SELECTED"}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {locked ? (
        <Lock className="size-4 shrink-0 text-muted-foreground" />
      ) : isAuto ? (
        <span className="text-xs font-medium text-accent-foreground">best ↓</span>
      ) : latencyMs === undefined ? (
        <span className="text-sm text-muted-foreground">---</span>
      ) : (
        <span
          className={cn(
            "flex items-center gap-0.5 text-sm font-bold",
            latencyColor(latencyMs),
          )}
        >
          <Bolt className="size-3.5" />
          {latencyMs}ms
        </span>
      )}
    </button>
  );
}
