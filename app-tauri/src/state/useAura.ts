// React port of Aura's `AppState` (ChangeNotifier) → a `useAura` hook.
// The UI owns the live login → connect → stats state machine; Rust owns the
// network/filesystem/engine boundary (see src/lib/api.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  authPoll,
  authStart,
  checkUpdate,
  clearAuth,
  closeSession,
  coreStart,
  coreStats,
  coreStop,
  heartbeat,
  legacySession,
  loadAuth,
  openBrowser,
  openSession,
  usageAdd,
  usageMonthUsed,
  type AuthErrorKind,
  type CoreStats,
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

interface Settings {
  killSwitch: boolean;
  exceptions: string[];
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("aura.settings");
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        killSwitch: !!p.killSwitch,
        exceptions: Array.isArray(p.exceptions)
          ? p.exceptions.filter((s): s is string => typeof s === "string")
          : [],
      };
    }
  } catch {
    /* corrupt — start fresh */
  }
  return { killSwitch: false, exceptions: [] };
}

function persistSettings(s: Settings) {
  localStorage.setItem("aura.settings", JSON.stringify(s));
}

/** Stable per-account id so usage follows the account and a NEW account starts at 0. */
function accountKey(s: SessionInfo | null): string {
  if (!s) return "unknown";
  const id = s.account?.discord_id || s.account?.username || "";
  return id ? `acct:${id}` : `acct:${s.session_id}`;
}

export function useAura() {
  const [phase, setPhase] = useState<Phase>("loggedOut");
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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [killSwitch, setKillSwitch] = useState<boolean>(() => loadSettings().killSwitch);
  const [exceptions, setExceptions] = useState<string[]>(() => loadSettings().exceptions);
  const [blocked, setBlocked] = useState(false);
  const [egressIp, setEgressIp] = useState<string | null>(null);
  const [proxyAddr, setProxyAddr] = useState<string | null>(null);

  // Refs mirror the values timers/async need so they never read stale state.
  const sessionRef = useRef<SessionInfo | null>(null);
  const phaseRef = useRef<Phase>("loggedOut");
  const selectedRef = useRef<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const accountIdRef = useRef<string>("unknown");
  const killSwitchRef = useRef<boolean>(loadSettings().killSwitch);
  const exceptionsRef = useRef<string[]>(loadSettings().exceptions);
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
  useEffect(() => {
    killSwitchRef.current = killSwitch;
  }, [killSwitch]);
  useEffect(() => {
    exceptionsRef.current = exceptions;
  }, [exceptions]);

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

  const finishLogin = useCallback(
    (s: SessionInfo) => {
      setSession(s);
      sessionRef.current = s;
      accountIdRef.current = accountKey(s);
      setBudget(s.config);
      syncSelected(s.config);
      setPhase("disconnected");
      log(`Discord session opened for ${s.account.display_name}`);
    },
    [log, setBudget, syncSelected],
  );

  const openSessionFresh = useCallback(async (): Promise<SessionInfo> => {
    const auth = loadAuth();
    if (!auth) throw "badCreds";
    if (auth.mode === "legacy") {
      return legacySession(auth.accountId!, auth.token);
    }
    return openSession(auth.token);
  }, []);

  // ---- login ----------------------------------------------------------------

  const loginWithDiscord = useCallback(async (): Promise<boolean> => {
    setAuthError(null);
    try {
      const start = await authStart();
      await openBrowser(start.authorize_url);
      const deadline = start.expires_at * 1000;
      let token: string | null = null;
      while (Date.now() < deadline) {
        const poll = await authPoll(start.login_id, start.login_secret);
        if (!poll.approved) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        token = poll.token;
        break;
      }
      if (!token) throw "network";
      saveDiscordAuth(token);
      const session = await openSession(token);
      finishLogin(session);
      return true;
    } catch (e) {
      const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
      setAuthError(kind);
      setPhase("loggedOut");
      return false;
    }
  }, [finishLogin]);

  const loginWithDiscordViaHandoff = useCallback(async (): Promise<boolean> => {
    setAuthError(null);
    try {
      const start = await authStart();
      await openBrowser(start.handoff_url || start.authorize_url);
      const deadline = start.expires_at * 1000;
      let token: string | null = null;
      while (Date.now() < deadline) {
        const poll = await authPoll(start.login_id, start.login_secret);
        if (!poll.approved) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        token = poll.token;
        break;
      }
      if (!token) throw "network";
      saveDiscordAuth(token);
      const session = await openSession(token);
      finishLogin(session);
      return true;
    } catch (e) {
      const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
      setAuthError(kind);
      setPhase("loggedOut");
      return false;
    }
  }, [finishLogin]);

  const loginLegacy = useCallback(
    async (accountId: string, token: string): Promise<boolean> => {
      setAuthError(null);
      if (!accountId.trim() || !token.trim()) {
        setAuthError("badCreds");
        return false;
      }
      try {
        saveLegacyAuth(accountId.trim(), token.trim());
        const session = await legacySession(accountId.trim(), token.trim());
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

  const selectServer = useCallback(
    (tag: string): boolean => {
      if (phaseRef.current === "connected" || phaseRef.current === "connecting") {
        log("server selection locked while connected");
        return false;
      }
      if (tag !== AUTO_TAG && !sessionRef.current?.config.servers.some((s) => s.tag === tag)) {
        return false;
      }
      if (selectedRef.current === tag) return true;
      setSelectedServerTag(tag);
      log(`selected server: ${tag}`);
      return true;
    },
    [log],
  );

  // ---- connect / disconnect ------------------------------------------------

  const disconnect = useCallback(async () => {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    if (statsTimer.current) clearInterval(statsTimer.current);
    const s = sessionRef.current;
    if (s) void closeSession(s.session_id);
    setProxyAddr(null);
    setEgressIp(null);
    try {
      const blockedAfter = await coreStop();
      setBlocked(blockedAfter);
    } catch {
      log("disconnect warning: could not stop engine");
    }
    setActiveServer(null);
    activeRef.current = null;
    setUpBytes(0);
    setDownBytes(0);
    setLatencies({});
    setPhase("disconnected");
    log("disconnected");
  }, [log]);

  const startStats = useCallback(() => {
    if (statsTimer.current) clearInterval(statsTimer.current);
    prevUpRef.current = 0;
    prevDownRef.current = 0;
    missesRef.current = 0;
    pendingUsageRef.current = 0;
    const tick = async () => {
      try {
        const stats = await coreStats();
        const running = stats.running;
        setBlocked(stats.blocked);
        setEgressIp(stats.egress_ip);
        setProxyAddr(stats.proxy_addr);
        if (!running) {
          if (killSwitchRef.current) setBlocked(true);
          missesRef.current++;
          if (missesRef.current >= 3) {
            if (statsTimer.current) clearInterval(statsTimer.current);
            setStatusLine("the tunnel engine stopped unexpectedly — tap connect to repair");
            log("aura-core reports that the tunnel engine exited");
            setPhase("error");
            return;
          }
          setStatusLine("tunnel connected — live status temporarily unavailable");
        } else {
          missesRef.current = 0;
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
          setStatusLine("budget blown. disconnecting. we'll be so back next month.");
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
      if (!s || s.expires_at * 1000 - Date.now() < 3600_000) {
        s = await openSessionFresh();
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
        setStatusLine(
          `monthly budget (${cfg.budget_gb}GB) used up — the aura is tapped out until next month`,
        );
        setPhase("error");
        return false;
      }
      const isAuto = tag === AUTO_TAG;
      const selected = cfg.servers.find((x) => x.tag === tag) ?? cfg.servers[0];
      if (!selected) throw new Error("no servers to connect");
      const active = await coreStart(
        isAuto,
        selected,
        cfg.servers,
        cfg.prefer_ip,
        killSwitchRef.current,
        exceptionsRef.current,
      );
      setBlocked(false);
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
        setStatusLine("monthly budget used up — the aura is tapped out until next month");
        setPhase("error");
      } else if (typeof e === "string" && isAuthKind(e)) {
        setAuthError(e);
        setSession(null);
        sessionRef.current = null;
        clearAuth();
        setPhase("loggedOut");
      } else {
        setStatusLine(`connect failed: ${msg}`);
        log(`ERROR ${msg}`);
        setPhase("error");
      }
      return false;
    }
  }, [disconnect, log, openSessionFresh, setBudget, startStats, syncSelected]);

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
      accountIdRef.current = accountKey(s);
      setBudget(s.config);
      syncSelected(s.config);
      const used = await usageMonthUsed(accountIdRef.current);
      monthUsedRef.current = used;
      setMonthUsed(used);
      log(`config refreshed: ${s.config.servers.length} servers`);
      setPhase(wasConnected ? "connected" : "disconnected");
    } catch (e) {
      const msg = typeof e === "string" && isAuthKind(e) ? e : "network";
      if (isAuthKind(msg)) {
        setAuthError(msg);
        setSession(null);
        sessionRef.current = null;
        clearAuth();
        setPhase("loggedOut");
      } else {
        setStatusLine(`could not summon the config: ${msg}`);
        setPhase("error");
      }
    }
  }, [log, openSessionFresh, setBudget, syncSelected]);

  const checkForUpdate = useCallback(async () => {
    try {
      const v = await checkUpdate();
      if (v && v !== updateVersion) {
        setUpdateVersion(v);
        log(`update available: ${v} — installing is one click away`);
      }
    } catch (e) {
      log(`update check failed: ${e}`);
    }
  }, [log, updateVersion]);

  // ---- init ----------------------------------------------------------------

  const init = useCallback(async () => {
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
        log(`welcome back, ${s.account.display_name}`);
      } catch (e) {
        const kind = typeof e === "string" && isAuthKind(e) ? e : "network";
        setAuthError(kind);
        clearAuth();
        setPhase("loggedOut");
      }
    } else {
      setPhase("loggedOut");
    }
    void checkForUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void init();
    return () => {
      if (statsTimer.current) clearInterval(statsTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setKillSwitchSetting = useCallback((v: boolean) => {
    setKillSwitch(v);
    killSwitchRef.current = v;
    persistSettings({ killSwitch: v, exceptions: exceptionsRef.current });
  }, []);

  const addException = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setExceptions((prev) => {
      if (prev.includes(trimmed)) return prev;
      const next = [...prev, trimmed];
      exceptionsRef.current = next;
      persistSettings({ killSwitch: killSwitchRef.current, exceptions: next });
      return next;
    });
  }, []);

  const removeException = useCallback((value: string) => {
    setExceptions((prev) => {
      const next = prev.filter((x) => x !== value);
      exceptionsRef.current = next;
      persistSettings({ killSwitch: killSwitchRef.current, exceptions: next });
      return next;
    });
  }, []);

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
    logs,
    killSwitch,
    exceptions,
    blocked,
    egressIp,
    proxyAddr,
    setKillSwitch: setKillSwitchSetting,
    addException,
    removeException,
    init,
    loginWithDiscord,
    loginWithDiscordViaHandoff,
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
