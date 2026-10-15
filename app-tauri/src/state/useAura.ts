// React port of Aura's `AppState` (ChangeNotifier) → a `useAura` hook.
// The UI owns the live login → connect → stats state machine; Rust owns the
// network/filesystem/engine boundary (see src/lib/api.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  authPoll,
  authStart,
  checkUpdate,
  installUpdate,
  loadSplitTunnel,
  clearAuth,
  closeSession,
  coreHelper,
  coreInstall,
  coreUninstall,
  coreStart,
  coreStats,
  coreStop,
  heartbeat,
  legacySession,
  licenseSession,
  saveLicenseAuth,
  loadAuth,
  openBrowser,
  openSession,
  probeServers,
  usageAdd,
  usageMonthUsed,
  type AuthErrorKind,
  type CoreStats,
  type HelperInfo,
  type ServerConfig,
  type ServerInfo,
  type SessionInfo,
  saveDiscordAuth,
  saveLegacyAuth,
} from "@/lib/api";

export type Phase =
  | "loggedOut"
  | "disconnected"
  | "fetchingConfig"
  | "connecting"
  | "connected"
  | "error";

export type LogLevel = "info" | "warning" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

const GB = 1024 * 1024 * 1024;

function logLevel(message: string): LogLevel {
  const n = message.toLowerCase();
  if (/(error|failed|exhausted|stopped unexpectedly)/.test(n)) return "error";
  if (/(warning|ignored|recovering)/.test(n)) return "warning";
  return "info";
}

const AUTH_KINDS: AuthErrorKind[] = [
  "badCreds",
  "accountExpired",
  "accountDisabled",
  "noCredit",
  "poolExhausted",
  "sessionGone",
];
const isAuthKind = (v: string): v is AuthErrorKind =>
  (AUTH_KINDS as string[]).includes(v);

/** The tag sentinel for the "Automatic" (best-server) option. */
export const AUTO_TAG = "automatic";

/** Stable per-account id so usage follows the account and a NEW account starts at 0. */
function accountKey(s: SessionInfo | null): string {
  if (!s) return "unknown";
  const id = s.account?.discord_id || s.account?.username || "";
  return id ? `acct:${id}` : `acct:${s.session_id}`;
}

export function useAura() {
  // Returning users start in the loading state, not on the login screen.
  const [phase, setPhase] = useState<Phase>(() => (loadAuth() ? "fetchingConfig" : "loggedOut"));
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [activeServer, setActiveServer] = useState<string | null>(null);
  const [selectedServerTag, setSelectedServerTag] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<Record<string, number>>({});
  const [upBytes, setUpBytes] = useState(0);
  const [downBytes, setDownBytes] = useState(0);
  const [monthUsed, setMonthUsed] = useState(0);
  const [budgetBytes, setBudgetBytes] = useState(0);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [authError, setAuthError] = useState<AuthErrorKind | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [autoConnectPending, setAutoConnectPending] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tailscale, setTailscale] = useState("");
  const [egressIp, setEgressIp] = useState<string | null>(null);
  const [proxyAddr, setProxyAddr] = useState<string | null>(null);
  const [debugMode, setDebugModeState] = useState<boolean>(
    () => localStorage.getItem("aura.debug") === "1",
  );
  // Assume installed until the first probe so the banner doesn't flash.
  const [helper, setHelper] = useState<HelperInfo>({
    installed: true,
    version: null,
    outdated: false,
    bundled_version: "",
  });
  const [helperBusy, setHelperBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const dismissInstallError = useCallback(() => setInstallError(null), []);

  const detectCore = useCallback(async () => {
    const info = await coreHelper().catch(() => null);
    setHelper(info ?? { installed: false, version: null, outdated: false, bundled_version: "" });
  }, []);
  const installCore = useCallback(async () => {
    setHelperBusy(true);
    try {
      await coreInstall();
      // The service needs a moment to start listening after install.
      await new Promise((r) => setTimeout(r, 1500));
      toast.success("Helper installed");
    } catch (e) {
      setInstallError(typeof e === "string" ? e : "Helper install failed");
    }
    await detectCore();
    setHelperBusy(false);
  }, [detectCore]);
  const uninstallCore = useCallback(async () => {
    setHelperBusy(true);
    await coreUninstall().catch(() => {});
    await detectCore();
    setHelperBusy(false);
  }, [detectCore]);
  const toggleDebug = useCallback(() => {
    setDebugModeState((s) => {
      const n = !s;
      localStorage.setItem("aura.debug", n ? "1" : "0");
      return n;
    });
  }, []);

  // Refs mirror the values timers/async need so they never read stale state.
  const sessionRef = useRef<SessionInfo | null>(null);
  const phaseRef = useRef<Phase>(loadAuth() ? "fetchingConfig" : "loggedOut");
  // Set once disconnect closes the session server-side; the next connect must
  // open a fresh one or its heartbeat 410s and logs the user out.
  const sessionClosedRef = useRef(false);
  const loginAbortRef = useRef<{ cancelled: boolean } | null>(null);
  const selectedRef = useRef<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const accountIdRef = useRef<string>("unknown");
  const monthUsedRef = useRef(0);
  const budgetRef = useRef(0);
  const prevUpRef = useRef(0);
  const prevDownRef = useRef(0);
  const missesRef = useRef(0);
  const pendingUsageRef = useRef(0);
  const lastReportedUsageRef = useRef(0);
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    selectedRef.current = selectedServerTag;
  }, [selectedServerTag]);
  useEffect(() => {
    activeRef.current = activeServer;
  }, [activeServer]);

  const log = useCallback((message: string) => {
    setLogs((prev) => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: logLevel(message),
        message,
      };
      return [entry, ...prev].slice(0, 500);
    });
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const syncSelected = useCallback((config: ServerConfig | undefined) => {
    const servers = config?.servers ?? [];
    setSelectedServerTag((prev) => {
      if (servers.length === 0) return null;
      if (prev === AUTO_TAG) return AUTO_TAG;
      if (prev && servers.some((s) => s.tag === prev)) return prev;
      return AUTO_TAG;
    });
  }, []);

  const setBudget = useCallback((config: ServerConfig | undefined) => {
    const b = (config?.budget_gb ?? 0) * GB;
    setBudgetBytes(b);
    budgetRef.current = b;
  }, []);

  const probeLatencies = useCallback((config: ServerConfig | undefined) => {
    if (!config?.servers.length) return;
    void probeServers(config.servers, config.prefer_ip)
      .then((l) => {
        if (phaseRef.current !== "connected") setLatencies(l);
      })
      .catch(() => {});
  }, []);

  const finishLogin = useCallback(
    (s: SessionInfo) => {
      setSession(s);
      sessionRef.current = s;
      accountIdRef.current = accountKey(s);
      setBudget(s.config);
      syncSelected(s.config);
      setPhase("disconnected");
      probeLatencies(s.config);
      log(`Discord session opened for ${s.account.display_name}`);
    },
    [log, probeLatencies, setBudget, syncSelected],
  );

  const openSessionFresh = useCallback(async (): Promise<SessionInfo> => {
    const auth = loadAuth();
    if (!auth) throw "badCreds";
    if (auth.mode === "legacy") {
      return legacySession(auth.accountId!, auth.token);
    }
    if (auth.mode === "license") return licenseSession(auth.token);
    return openSession(auth.token);
  }, []);

  // ---- login ----------------------------------------------------------------

  const discordLogin = useCallback(
    async (viaHandoff: boolean): Promise<boolean> => {
      loginAbortRef.current && (loginAbortRef.current.cancelled = true);
      const abort = { cancelled: false };
      loginAbortRef.current = abort;
      setAuthError(null);
      try {
        const start = await authStart();
        await openBrowser(viaHandoff ? start.handoff_url || start.authorize_url : start.authorize_url);
        const deadline = start.expires_at * 1000;
        let token: string | null = null;
        while (Date.now() < deadline && !abort.cancelled) {
          // One flaky poll shouldn't kill the whole login — keep trying.
          const poll = await authPoll(start.login_id, start.login_secret).catch((e) => {
            if (typeof e === "string" && isAuthKind(e)) throw e;
            return null;
          });
          if (poll?.approved) {
            token = poll.token;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (abort.cancelled) return false;
        if (!token) throw "network";
        saveDiscordAuth(token);
        const session = await openSession(token);
        sessionClosedRef.current = false;
        finishLogin(session);
        return true;
      } catch (e) {
        if (abort.cancelled) return false;
        const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
        setAuthError(kind);
        setPhase("loggedOut");
        return false;
      } finally {
        if (loginAbortRef.current === abort) loginAbortRef.current = null;
      }
    },
    [finishLogin],
  );
  const loginWithDiscord = useCallback(() => discordLogin(false), [discordLogin]);
  const loginWithDiscordViaHandoff = useCallback(() => discordLogin(true), [discordLogin]);
  const cancelLogin = useCallback(() => {
    if (loginAbortRef.current) loginAbortRef.current.cancelled = true;
  }, []);

  const loginLicense = useCallback(
    async (key: string): Promise<boolean> => {
      setAuthError(null);
      try {
        const session = await licenseSession(key);
        saveLicenseAuth(key);
        sessionClosedRef.current = false;
        finishLogin(session);
        return true;
      } catch (e) {
        const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
        setAuthError(kind);
        setPhase("loggedOut");
        return false;
      }
    },
    [finishLogin],
  );

  const loginLegacy = useCallback(
    async (accountId: string, token: string): Promise<boolean> => {
      setAuthError(null);
      if (!accountId.trim() || !token.trim()) {
        setAuthError("badCreds");
        return false;
      }
      try {
        const session = await legacySession(accountId.trim(), token.trim());
        saveLegacyAuth(accountId.trim(), token.trim());
        sessionClosedRef.current = false;
        finishLogin(session);
        return true;
      } catch (e) {
        const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
        setAuthError(kind);
        setPhase("loggedOut");
        return false;
      }
    },
    [finishLogin],
  );


  // ---- connect / disconnect ------------------------------------------------

  const disconnect = useCallback(async () => {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    if (statsTimer.current) clearInterval(statsTimer.current);
    const s = sessionRef.current;
    if (s) {
      void closeSession(s.session_id);
      sessionClosedRef.current = true;
    }
    setProxyAddr(null);
    setEgressIp(null);
    setTailscale("");
    try {
      await coreStop();
    } catch {
      log("disconnect warning: could not stop engine");
    }
    setActiveServer(null);
    activeRef.current = null;
    setUpBytes(0);
    setDownBytes(0);
    setLatencies({});
    setPhase("disconnected");
    // Sync the ref now so a reconnect right after (server switch) isn't refused.
    phaseRef.current = "disconnected";
    probeLatencies(sessionRef.current?.config);
    log("disconnected");
  }, [log, probeLatencies]);

  const startStats = useCallback(() => {
    if (statsTimer.current) clearInterval(statsTimer.current);
    prevUpRef.current = 0;
    prevDownRef.current = 0;
    missesRef.current = 0;
    pendingUsageRef.current = 0;
    let lastTick = 0;
    const tick = async () => {
      // Hidden in the menu bar nobody is watching the numbers: poll the helper
      // every 10s instead of every 2s.
      if (document.hidden && Date.now() - lastTick < 10_000) return;
      lastTick = Date.now();
      try {
        const stats = await coreStats();
        const running = stats.running;
        setEgressIp(stats.egress_ip);
        setProxyAddr(stats.proxy_addr);
        setTailscale(stats.tailscale ?? "");
        if (!running) {
          missesRef.current++;
          if (missesRef.current >= 3) {
            if (statsTimer.current) clearInterval(statsTimer.current);
            setStatusLine("The tunnel stopped unexpectedly. Connect again to repair it.");
            log("aura-core reports that the tunnel engine exited");
            setPhase("error");
            return;
          }
          setStatusLine("Live status is temporarily unavailable.");
        } else {
          missesRef.current = 0;
          setStatusLine(null);
        }
        const active = stats.active_server ?? null;
        setActiveServer(active);
        activeRef.current = active;
        setLatencies(stats.latencies);
        const up = stats.upload_total;
        const down = stats.download_total;
        setUpBytes(up);
        setDownBytes(down);
        const delta = up + down - (prevUpRef.current + prevDownRef.current);
        prevUpRef.current = up;
        prevDownRef.current = down;
        if (delta > 0) {
          monthUsedRef.current += delta;
          pendingUsageRef.current += delta;
          setMonthUsed(monthUsedRef.current);
        }
        if (pendingUsageRef.current > 0) {
          void usageAdd(accountIdRef.current, pendingUsageRef.current);
          pendingUsageRef.current = 0;
        }
        if (budgetRef.current > 0 && monthUsedRef.current >= budgetRef.current) {
          log(`budget exhausted (${Math.floor(monthUsedRef.current / (1024 * 1024))} MB) — hard stop`);
          setStatusLine("Monthly data budget used up — disconnected until next month.");
          void disconnect();
          return;
        }
      } catch {
        // transient — keep polling
      }
    };
    void tick();
    statsTimer.current = setInterval(tick, 2000);
  }, [disconnect, log]);

  const connect = useCallback(async (): Promise<boolean> => {
    if (phaseRef.current === "connected" || phaseRef.current === "connecting") {
      return false;
    }
    if (!sessionRef.current && !loadAuth()) {
      setPhase("loggedOut");
      return false;
    }
    setPhase("connecting");
    setStatusLine(null);
    try {
      let s = sessionRef.current;
      if (!s || sessionClosedRef.current || s.expires_at * 1000 - Date.now() < 3600_000) {
        s = await openSessionFresh();
        sessionClosedRef.current = false;
        setSession(s);
        sessionRef.current = s;
        setBudget(s.config);
        syncSelected(s.config);
      }
      const cfg = s.config;
      syncSelected(cfg);
      const tag = selectedRef.current;
      if (!tag) throw new Error("no server is available to connect");
      accountIdRef.current = accountKey(s);
      setBudget(cfg);
      const used = await usageMonthUsed(accountIdRef.current);
      monthUsedRef.current = used;
      setMonthUsed(used);
      lastReportedUsageRef.current = used;
      if (budgetRef.current > 0 && used >= budgetRef.current) {
        setStatusLine(`Monthly data budget (${cfg.budget_gb} GB) used up until next month.`);
        setPhase("error");
        return false;
      }
      const isAuto = tag === AUTO_TAG;
      const selected = cfg.servers.find((x) => x.tag === tag) ?? cfg.servers[0];
      if (!selected) throw new Error("no servers to connect");
      const active = await coreStart(isAuto, selected, cfg.servers, cfg.prefer_ip, loadSplitTunnel());
      setActiveServer(active);
      activeRef.current = active;
      setPhase("connected");
      log(`connected via ${active}`);

      // heartbeat every 10 minutes
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = setInterval(async () => {
        // Report the usage delta since the last heartbeat so the Worker can
        // enforce the monthly budget server-side.
        const delta = Math.max(0, monthUsedRef.current - lastReportedUsageRef.current);
        lastReportedUsageRef.current = monthUsedRef.current;
        const ok = await heartbeat(s.session_id, delta);
        if (!ok) {
          log("session expired server-side — logging out");
          await disconnect();
          setAuthError("sessionGone");
          setSession(null);
          sessionRef.current = null;
          clearAuth();
          setPhase("loggedOut");
        }
      }, 10 * 60 * 1000);

      startStats();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (typeof e === "string" && e === "budgetExceeded") {
        // Over-budget is not a logout — just refuse to start the tunnel.
        setStatusLine("Monthly data budget used up until next month.");
        setPhase("error");
      } else if (typeof e === "string" && isAuthKind(e)) {
        setAuthError(e);
        setSession(null);
        sessionRef.current = null;
        clearAuth();
        setPhase("loggedOut");
      } else {
        setStatusLine(msg.replace(/^network: /, "Network error: "));
        log(`ERROR ${msg}`);
        setPhase("error");
      }
      return false;
    }
  }, [disconnect, log, openSessionFresh, setBudget, startStats, syncSelected]);

  const selectServer = useCallback(
    (tag: string): boolean => {
      if (phaseRef.current === "connecting" || phaseRef.current === "fetchingConfig") return false;
      if (tag !== AUTO_TAG && !sessionRef.current?.config.servers.some((s) => s.tag === tag)) {
        return false;
      }
      if (selectedRef.current === tag) return true;
      setSelectedServerTag(tag);
      selectedRef.current = tag;
      log(`selected server: ${tag}`);
      if (phaseRef.current === "connected") {
        void disconnect().then(() => connect());
      }
      return true;
    },
    [connect, disconnect, log],
  );

  const logout = useCallback(async () => {
    await disconnect();
    clearAuth();
    setSession(null);
    sessionRef.current = null;
    setAuthError(null);
    setPhase("loggedOut");
    log("logged out");
  }, [disconnect, log]);

  const refreshConfig = useCallback(async () => {
    const wasConnected = phaseRef.current === "connected";
    setPhase("fetchingConfig");
    try {
      const s = await openSessionFresh();
      setSession(s);
      sessionRef.current = s;
      sessionClosedRef.current = false;
      accountIdRef.current = accountKey(s);
      setBudget(s.config);
      syncSelected(s.config);
      const used = await usageMonthUsed(accountIdRef.current);
      monthUsedRef.current = used;
      setMonthUsed(used);
      log(`config refreshed: ${s.config.servers.length} servers`);
      setPhase(wasConnected ? "connected" : "disconnected");
      if (!wasConnected) probeLatencies(s.config);
    } catch (e) {
      const msg = typeof e === "string" && isAuthKind(e) ? e : "network";
      if (isAuthKind(msg)) {
        setAuthError(msg);
        setSession(null);
        sessionRef.current = null;
        clearAuth();
        setPhase("loggedOut");
      } else {
        setStatusLine("Couldn't reach api.copal.run. Check your connection and retry.");
        setPhase("error");
      }
    }
  }, [log, openSessionFresh, probeLatencies, setBudget, syncSelected]);

  const updatingRef = useRef(false);
  const installAppUpdate = useCallback(async () => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    setUpdating(true);
    try {
      // The new build starts disconnected; don't leave a tunnel up with
      // nobody sending heartbeats.
      if (phaseRef.current === "connected" || phaseRef.current === "connecting") {
        await disconnect().catch(() => {});
      }
      log("downloading the update…");
      await installUpdate();
    } catch (e) {
      log(`update failed: ${e}`);
      toast.error(`Update failed: ${e}`);
    } finally {
      updatingRef.current = false;
      setUpdating(false);
    }
  }, [disconnect, log]);

  /** Looks for a newer Aura and returns its version. With `autoInstall`, an
   *  update found while the tunnel is down is installed straight away and
   *  Aura restarts into it; while connected it waits for the user to press
   *  Update. */
  const checkForUpdate = useCallback(
    async (autoInstall = false): Promise<string | null> => {
      let v: string | null = null;
      try {
        v = await checkUpdate();
      } catch (e) {
        log(`update check failed: ${e}`);
      }
      if (!v) return null;
      setUpdateVersion(v);
      log(`update available: ${v}`);
      if (autoInstall && phaseRef.current !== "connected" && phaseRef.current !== "connecting") {
        await installAppUpdate();
      }
      return v;
    },
    [installAppUpdate, log],
  );

  // Long-running installs pick up releases too.
  useEffect(() => {
    const timer = setInterval(() => void checkForUpdate(true), 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [checkForUpdate]);

  // ---- init ----------------------------------------------------------------

  const init = useCallback(async () => {
    // Updates first, so a login launch doesn't connect only to restart. A
    // successful install restarts Aura; a failed one carries on as usual.
    await checkForUpdate(true);
    const auth = loadAuth();
    if (auth) {
      try {
        const s = await openSessionFresh();
        setSession(s);
        sessionRef.current = s;
        accountIdRef.current = accountKey(s);
        setBudget(s.config);
        syncSelected(s.config);
        const used = await usageMonthUsed(accountIdRef.current);
        monthUsedRef.current = used;
        setMonthUsed(used);
        setPhase("disconnected");
        probeLatencies(s.config);
        log(`welcome back, ${s.account.display_name}`);
        if (localStorage.getItem("aura.autoconnect") === "1") setAutoConnectPending(true);
      } catch (e) {
        if (typeof e === "string" && isAuthKind(e)) {
          setAuthError(e);
          clearAuth();
          setPhase("loggedOut");
        } else {
          // Offline / API hiccup: keep the saved login and let the user retry.
          setStatusLine("Couldn't reach api.copal.run. Check your connection and retry.");
          log(`startup: ${e}`);
          setPhase("error");
        }
      }
    } else {
      setPhase("loggedOut");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Connect when Aura opens": runs once the saved login has loaded.
  useEffect(() => {
    if (!autoConnectPending || phase !== "disconnected") return;
    setAutoConnectPending(false);
    log("connecting automatically");
    void connect();
  }, [autoConnectPending, phase, connect, log]);

  useEffect(() => {
    void init();
    void detectCore();
    return () => {
      if (statsTimer.current) clearInterval(statsTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- menu bar ------------------------------------------------------------
  // The tray forwards clicks as events; keep the latest handlers in a ref so
  // the listeners are registered once.
  const trayActions = useRef({ connect, disconnect });
  trayActions.current = { connect, disconnect };
  useEffect(() => {
    const unlisteners = [
      listen("tray://toggle", () => {
        if (phaseRef.current === "connected") void trayActions.current.disconnect();
        else if (phaseRef.current !== "connecting" && phaseRef.current !== "fetchingConfig") {
          void trayActions.current.connect();
        }
      }),
      listen("tray://quit", async () => {
        // Don't leave the tunnel up with nobody sending heartbeats.
        if (phaseRef.current === "connected" || phaseRef.current === "connecting") {
          await trayActions.current.disconnect().catch(() => {});
        }
        await invoke("app_quit");
      }),
    ];
    return () => unlisteners.forEach((u) => void u.then((f) => f()));
  }, []);

  useEffect(() => {
    const label: Record<Phase, string> = {
      loggedOut: "Signed out",
      disconnected: "Disconnected",
      fetchingConfig: "Loading…",
      connecting: "Connecting…",
      connected: `Connected${activeServer ? ` · ${activeServer.charAt(0).toUpperCase()}${activeServer.slice(1)}` : ""}`,
      error: "Not connected",
    };
    void invoke("tray_update", {
      status: label[phase],
      connected: phase === "connected",
      busy: phase === "connecting" || phase === "fetchingConfig",
    }).catch(() => {});
  }, [phase, activeServer]);

  const budgetFraction = budgetBytes > 0 ? monthUsed / budgetBytes : 0;
  const budgetWarn = budgetBytes > 0 && budgetFraction >= 0.8 && !(monthUsed >= budgetBytes);
  const overBudget = budgetBytes > 0 && monthUsed >= budgetBytes;

  return {
    phase,
    session,
    accountStatus: session?.account ?? null,
    serverConfig: session?.config ?? null,
    activeServer,
    selectedServerTag,
    latencies,
    upBytes,
    downBytes,
    monthUsed,
    budgetBytes,
    budgetFraction,
    budgetWarn,
    overBudget,
    statusLine,
    authError,
    updateVersion,
    updating,
    installAppUpdate,
    logs,
    egressIp,
    proxyAddr,
    tailscale,
    debugMode,
    helper,
    helperBusy,
    toggleDebug,
    installCore,
    uninstallCore,
    installError,
    dismissInstallError,
    init,
    loginWithDiscord,
    loginWithDiscordViaHandoff,
    cancelLogin,
    loginLicense,
    loginLegacy,
    selectServer,
    connect,
    disconnect,
    logout,
    refreshConfig,
    checkForUpdate,
    clearLogs,
  };
}

export type Aura = ReturnType<typeof useAura>;
export type { ServerConfig, ServerInfo, SessionInfo, CoreStats };
