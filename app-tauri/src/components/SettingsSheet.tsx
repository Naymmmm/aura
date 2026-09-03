import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Aura } from "@/state/useAura";
import { ShieldBan, ListPlus, Database, X } from "lucide-react";

export function SettingsSheet({
  aura,
  open,
  onOpenChange,
}: {
  aura: Aura;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [newException, setNewException] = useState("");

  function addException() {
    aura.addException(newException);
    setNewException("");
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="scrollbar-none w-full max-w-sm border-border bg-card p-0">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-base font-bold">Tunnel settings</SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Applied the next time you connect.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-80px)]">
          <div className="flex flex-col gap-6 px-5 py-5">
            {/* Kill switch */}
            <section className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <ShieldBan className="size-5" />
              </span>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">Kill switch</h3>
                  <Switch
                    checked={aura.killSwitch}
                    onCheckedChange={(v) => aura.setKillSwitch(!!v)}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  If the tunnel drops, block all non-tunnel traffic until you
                  reconnect or turn this off.
                </p>
              </div>
            </section>

            {aura.blocked && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs font-medium text-destructive">
                Kill switch engaged — traffic is blocked right now.
              </div>
            )}

            {/* Split tunnel exceptions */}
            <section className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ListPlus className="size-5" />
              </span>
              <div className="flex-1">
                <h3 className="text-sm font-bold">Split-tunnel exceptions</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Hosts or apps that bypass the tunnel exclusively.
                </p>
                <div className="mt-3 flex gap-2">
                  <Input
                    value={newException}
                    onChange={(e) => setNewException(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && addException()}
                    placeholder="e.g. 1.1.1.1 or *.local"
                  />
                  <Button variant="secondary" size="sm" onClick={addException}>
                    Add
                  </Button>
                </div>
                {aura.exceptions.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {aura.exceptions.map((exc) => (
                      <Badge key={exc} variant="secondary" className="gap-1 pr-1">
                        {exc}
                        <button
                          type="button"
                          onClick={() => aura.removeException(exc)}
                          className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                          aria-label={`remove ${exc}`}
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Everything goes through the tunnel.
                  </p>
                )}
              </div>
            </section>
          </div>
        </ScrollArea>

        {/* Per-account usage */}
        <div className="border-t border-border px-5 py-4">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Database className="mt-0.5 size-4" />
            <p>
              Data usage is tracked <span className="font-semibold">per account</span>.
              Signing in to a different account starts that account fresh at 0 —
              your used data never carries over.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
