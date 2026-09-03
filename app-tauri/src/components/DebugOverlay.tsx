import { useEffect, useState } from "react";
import { getLastApiError, onApiError } from "@/lib/api";
import type { Aura } from "@/state/useAura";
import { X, Terminal, Bug } from "lucide-react";

export function DebugOverlay({ aura, onClose }: { aura: Aura; onClose: () => void }) {
  const [lastError, setLastError] = useState<string | null>(() => getLastApiError());

  useEffect(() => onApiError((e) => setLastError(e)), []);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Bug className="size-4 text-primary" />
          <h1 className="text-sm font-bold">Aura debug</h1>
          <button
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-border px-4 py-3 text-xs">
          <Meta k="phase" v={aura.phase} />
          <Meta k="server" v={aura.activeServer ?? aura.selectedServerTag ?? "-"} />
          <Meta k="download" v={`${(aura.downBytes / (1 << 20)).toFixed(1)} MB`} />
          <Meta k="engine" v={`kill-switch ${aura.killSwitch ? "on" : "off"}`} />
        </div>

        <div className="border-b border-border px-4 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
            <Terminal className="size-3.5" />
            Last API error
          </div>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 font-mono text-[11px] text-destructive">
            {lastError ?? "No API failure recorded yet."}
          </pre>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-1 text-xs font-bold text-muted-foreground">Logs ({aura.logs.length})</div>
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {aura.logs.length === 0 ? (
              <p className="text-muted-foreground">No log entries yet.</p>
            ) : (
              aura.logs.map((e, i) => (
                <div
                  key={`${e.timestamp}-${i}`}
                  className={
                    e.level === "error"
                      ? "text-destructive"
                      : e.level === "warning"
                        ? "text-amber-400"
                        : "text-muted-foreground"
                  }
                >
                  <span className="opacity-60">{e.timestamp} </span>
                  {e.message}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="truncate font-semibold">{v}</div>
    </div>
  );
}
