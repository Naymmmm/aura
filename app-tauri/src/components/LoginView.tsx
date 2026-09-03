import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { AuraMark } from "@/components/AuraMark";
import { authError, rules } from "@/lib/lines";
import type { Aura } from "@/state/useAura";
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Smartphone,
  KeyRound,
  Eye,
  EyeOff,
} from "lucide-react";

export function LoginView({ aura }: { aura: Aura }) {
  const [busy, setBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [obscureToken, setObscureToken] = useState(true);
  const [localError, setLocalError] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setLocalError("");
    const ok = await aura.loginWithDiscord();
    setBusy(false);
    if (!ok) setLocalError("");
  }

  async function submitRemote() {
    if (remoteBusy) return;
    setRemoteBusy(true);
    setLocalError("");
    await aura.loginWithDiscordViaHandoff();
    setRemoteBusy(false);
  }

  async function submitLegacy() {
    if (legacyBusy) return;
    const id = accountId.trim();
    const tok = token.trim();
    if (!id || !tok) {
      setLocalError("enter both legacy credentials");
      return;
    }
    setLegacyBusy(true);
    setLocalError("");
    await aura.loginLegacy(id, tok);
    setLegacyBusy(false);
  }

  const errorLine = localError || authError(aura.authError);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md border-border shadow-2xl">
        <CardHeader className="items-center justify-items-center gap-2 text-center">
          <div className="flex h-16 w-16 items-center justify-center justify-self-center rounded-2xl bg-primary">
            <AuraMark size={42} color="var(--primary-foreground)" />
          </div>
          <CardTitle className="text-2xl font-black tracking-[0.35em]">
            AURA
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            sign in with Discord to unlock Aura VPN
          </p>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <Button size="lg" className="w-full font-extrabold tracking-wide" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "CONTINUE WITH DISCORD"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="mx-auto text-muted-foreground"
            onClick={() => setShowMore((s) => !s)}
          >
            More sign-in options
            {showMore ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>

          {showMore && (
            <div className="flex flex-col gap-4">
              <Separator />
              <div>
                <h3 className="text-sm font-extrabold">Filtered network?</h3>
                <p className="text-xs text-muted-foreground">
                  Open a temporary handoff and approve Discord from another,
                  unfiltered device.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={submitRemote}
                  disabled={remoteBusy}
                >
                  {remoteBusy ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" />}
                  Use another device
                </Button>
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-muted-foreground" />
                  <span className="text-sm font-extrabold">Legacy access</span>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="accountId">account id</Label>
                  <Input
                    id="accountId"
                    autoComplete="off"
                    value={accountId}
                    onChange={(e) => setAccountId(e.currentTarget.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="token">api token</Label>
                  <div className="relative">
                    <Input
                      id="token"
                      type={obscureToken ? "password" : "text"}
                      autoComplete="off"
                      className="pr-9"
                      value={token}
                      onChange={(e) => setToken(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitLegacy()}
                    />
                    <button
                      type="button"
                      onClick={() => setObscureToken((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      title={obscureToken ? "show token" : "hide token"}
                    >
                      {obscureToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>
                <Button variant="secondary" size="sm" onClick={submitLegacy} disabled={legacyBusy}>
                  {legacyBusy ? <Loader2 className="size-4 animate-spin" /> : "SIGN IN WITH LEGACY ACCESS"}
                </Button>
              </div>
            </div>
          )}

          <p className="text-center text-xs text-muted-foreground">
            A browser window will open. Your Aura session lasts 14 days.
          </p>

          {errorLine && (
            <p className="text-center text-xs font-medium text-destructive">{errorLine}</p>
          )}

          <div className="mt-2 rounded-xl border border-border bg-muted/40 p-4">
            <p className="text-[10px] font-extrabold tracking-widest text-muted-foreground">
              THE RULES
            </p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
              {rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
