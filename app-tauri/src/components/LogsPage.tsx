import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Aura, LogLevel } from "@/state/useAura";
import { ArrowLeft, Copy, Trash2, Search } from "lucide-react";

const levelColor: Record<LogLevel, string> = {
  info: "text-primary",
  warning: "text-amber-400",
  error: "text-destructive",
};

const levelBorder: Record<LogLevel, string> = {
  info: "border-primary",
  warning: "border-amber-400",
  error: "border-destructive",
};

const LEVELS: Array<LogLevel | "all"> = ["all", "info", "warning", "error"];

export function LogsPage({ aura, onClose }: { aura: Aura; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return aura.logs.filter((e) => {
      const formatted = `${e.timestamp} ${e.level.toUpperCase()} ${e.message}`.toLowerCase();
      return (level === "all" || e.level === level) && (q === "" || formatted.includes(q));
    });
  }, [aura.logs, query, level]);

  async function copyVisible() {
    const text = entries.map((e) => `${e.timestamp} ${e.level.toUpperCase()} ${e.message}`).join("\n");
    await navigator.clipboard.writeText(text);
    toast.success("Visible diagnostics copied");
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="back">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="text-sm font-bold">Diagnostics</h1>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={copyVisible} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="copy visible logs">
            <Copy className="size-4" />
          </button>
          <button onClick={aura.clearLogs} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="clear logs">
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3 pt-1">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search diagnostics"
            className="h-8 w-full rounded-lg border border-border bg-card pl-8 pr-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={level}
          onChange={(e) => setLevel(e.currentTarget.value as LogLevel | "all")}
          className="h-8 rounded-lg border border-border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === "all" ? "All levels" : l}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {entries.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">No matching diagnostics</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.map((e, i) => (
              <div
                key={`${e.timestamp}-${i}`}
                className={cn("rounded-xl border-l-[3px] bg-card px-3 py-2.5 text-xs text-muted-foreground", levelBorder[e.level])}
              >
                <span className={cn("mr-1.5 font-mono font-bold", levelColor[e.level])}>
                  {e.level.toUpperCase()}
                </span>
                <span className="font-mono">
                  {e.timestamp} {e.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
