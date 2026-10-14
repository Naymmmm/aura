import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { AuraMark } from "@/components/AuraMark";
import { extractLicenseKey, readLicenseFile } from "@/lib/api";
import { authError, rules } from "@/lib/lines";
import { cn } from "@/lib/utils";
import type { Aura } from "@/state/useAura";
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  FileKey,
  KeyRound,
  Eye,
  EyeOff,
} from "lucide-react";

export function LoginView({ aura, onDebug }: { aura: Aura; onDebug: () => void }) {
  const logoClicks = useRef(0);
  const pressLogo = () => {
    logoClicks.current += 1;
    if (logoClicks.current >= 5) {
      logoClicks.current = 0;
      onDebug();
    }
  };
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [obscureToken, setObscureToken] = useState(true);
  const [localError, setLocalError] = useState("");
  const [legacyBusy, setLegacyBusy] = useState(false);

  async function submitLicense(raw = licenseKey) {
    if (licenseBusy) return;
    const key = extractLicenseKey(raw);
    if (!key) {
      setLocalError("that doesn't look like an Aura key (AURA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX)");
      return;
    }
    setLicenseKey(key);
    setLicenseBusy(true);
    setLocalError("");
    await aura.loginLicense(key);
    setLicenseBusy(false);
  }

  function applyLicenseText(text: string) {
    const key = extractLicenseKey(text);
    if (!key) {
      setLocalError("no Aura key found in that file");
      return;
    }
    void submitLicense(key);
  }

  // Tauri swallows HTML drag-and-drop of files, so listen on the webview.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const path = p.paths[0];
          if (path) {
            readLicenseFile(path)
              .then(applyLicenseText)
              .catch((e) => setLocalError(String(e)));
          }
        }
      })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitDiscord() {
    if (busy) return;
    setBusy(true);
    setLocalError("");
    await aura.loginWithDiscord();
    setBusy(false);
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
    <div
      className={cn(
        "flex min-h-screen w-full justify-center overflow-y-auto bg-background px-6 py-10 transition-colors",
        dragging && "bg-primary/5 ring-2 ring-inset ring-primary/50",
      )}
    >
      <div className="flex w-full max-w-xs flex-col gap-4">
        <div className="mb-2 flex flex-col items-center gap-3 text-center">
          <button
            type="button"
            onClick={pressLogo}
            className="flex size-12 items-center justify-center rounded-xl bg-primary"
            title="Aura"
          >
            <AuraMark size={30} color="var(--primary-foreground)" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">Sign in to Aura</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {dragging ? "Drop your .auralicense file" : "Enter your license key"}
            </p>
          </div>
        </div>

          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="AURA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
              className="h-10 text-center font-mono text-xs tracking-wide"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.currentTarget.value)}
              onPaste={(e) => {
                const key = extractLicenseKey(e.clipboardData.getData("text"));
                if (key) {
                  e.preventDefault();
                  void submitLicense(key);
                }
              }}
              onKeyDown={(e) => e.key === "Enter" && submitLicense()}
            />
            <Button className="h-10 w-full font-semibold" onClick={() => submitLicense()} disabled={licenseBusy}>
              {licenseBusy ? <Loader2 className="size-4 animate-spin" /> : "Sign in"}
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => fileInput.current?.click()}>
              <FileKey className="size-4" />
              Open license file
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".auralicense,.txt"
              className="hidden"
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) applyLicenseText(await file.text());
              }}
            />
          </div>

          <p className="text-center text-xs text-muted-foreground">
            No key? Run <span className="font-mono text-foreground">/license</span> in the Aura
            Discord from your phone or any device, then paste the key or drop the file here.
          </p>

          {errorLine && (
            <p className="text-center text-xs font-medium text-destructive">{errorLine}</p>
          )}

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
                <h3 className="text-sm font-semibold">Discord</h3>
                <p className="text-xs text-muted-foreground">
                  Only works if this network can reach Discord.
                </p>
                {busy ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <span className="text-xs">Approve the login in your browser…</span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={aura.cancelLogin}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" className="mt-2 w-full" onClick={submitDiscord}>
                    Continue with Discord
                  </Button>
                )}
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Legacy access</span>
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
                  {legacyBusy ? <Loader2 className="size-4 animate-spin" /> : "Sign in with legacy access"}
                </Button>
              </div>
            </div>
          )}

          <div className="mt-2 rounded-lg border border-border/60 p-3">
            <p className="text-xs font-medium text-muted-foreground">House rules</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
              {rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </div>
      </div>
    </div>
  );
}
