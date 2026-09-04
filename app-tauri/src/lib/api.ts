// Typed bridge to the Rust commands. Mirrors Aura's Dart services, but the
// network/filesystem/engine work now lives in Rust; the React UI holds state.

import { invoke } from "@tauri-apps/api/core";

// ---- last-error capture (for the debug overlay) -----------------------------
let lastApiError: string | null = null;
type ErrorListener = (e: string | null) => void;
const errorListeners = new Set<ErrorListener>();

export function onApiError(cb: ErrorListener): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

export function getLastApiError(): string | null {
  return lastApiError;
}

function recordApiError(e: unknown) {
  lastApiError = typeof e === "string" ? e : String(e);
  errorListeners.forEach((cb) => cb(lastApiError));
}

/** Thin wrapper so every failed invoke is recorded for the debug overlay. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    recordApiError(e);
    throw e;
  }
}

export type AuthErrorKind =
  | "badCreds"
  | "accountExpired"
  | "accountDisabled"
  | "noCredit"
  | "budgetExceeded"
  | "poolExhausted"
  | "sessionGone"
  | "network";

export type AccountPlan = "none" | "free_trial" | "standard";

export interface ServerInfo {
  tag: string;
  host: string;
  ip: string;
  username: string;
  password: string;
}

export interface ServerConfig {
  version: number;
  prefer_ip: boolean;
  budget_gb: number;
  servers: ServerInfo[];
}

export interface AccountStatus {
  discord_id: string;
  username: string;
  display_name: string;
  expires_at: number | null;
  budget_gb: number;
  plan: AccountPlan;
}

export interface SessionInfo {
  config: ServerConfig;
  session_id: string;
  expires_at: number;
  account: AccountStatus;
}

export interface AuthStart {
  login_id: string;
  login_secret: string;
  authorize_url: string;
  handoff_url: string;
  expires_at: number;
}

export interface AuthPoll {
  approved: boolean;
  token: string | null;
  token_expires_at: number | null;
  account: AccountStatus | null;
}

export interface CoreStatus {
  version: string;
  running: boolean;
  kill_switch: boolean;
  blocked: boolean;
  egress_ip: string | null;
  proxy_addr: string | null;
  last_error: string | null;
}

export interface CoreStats {
  running: boolean;
  active_server: string | null;
  latencies: Record<string, number>;
  upload_total: number;
  download_total: number;
  kill_switch: boolean;
  blocked: boolean;
  egress_ip: string | null;
  proxy_addr: string | null;
  last_error: string | null;
}

export const appMeta = () =>
  call<{ version: string; api_base: string }>("app_meta");

export const authStart = () => call<AuthStart>("auth_start");
export const authPoll = (loginId: string, loginSecret: string) =>
  call<AuthPoll>("auth_poll", { login_id: loginId, login_secret: loginSecret });
export const openBrowser = (url: string) => call<void>("open_browser", { url });

export const openSession = (token: string) =>
  call<SessionInfo>("open_session", { token });
export const legacySession = (accountId: string, token: string) =>
  call<SessionInfo>("legacy_session", { account_id: accountId, token });
export const heartbeat = (sessionId: string, delta = 0) =>
  call<boolean>("heartbeat", { session_id: sessionId, delta });
export const closeSession = (sessionId: string) =>
  call<void>("close_session", { session_id: sessionId });
export const checkUpdate = () => call<string | null>("check_update");

export const coreStart = (
  auto: boolean,
  selected: ServerInfo,
  servers: ServerInfo[],
  preferIp: boolean,
  killSwitch: boolean,
  exceptions: string[],
) =>
  call<string>("core_start", {
    auto,
    selected,
    servers,
    prefer_ip: preferIp,
    kill_switch: killSwitch,
    exceptions,
  });
export const coreStop = () => call<boolean>("core_stop");
export const coreStatus = () => call<CoreStatus>("core_status");
export const coreStats = () => call<CoreStats>("core_stats");
export const coreLog = () => call<string>("core_log");
export const coreDetected = () => call<boolean>("core_detected");
export const coreInstall = () => call<void>("core_install");
export const coreUninstall = () => call<void>("core_uninstall");

export const usageMonthUsed = (accountId: string) =>
  call<number>("usage_month_used", { account_id: accountId });
export const usageAdd = (accountId: string, delta: number) =>
  call<void>("usage_add", { account_id: accountId, delta });

export type AuthMode = "discord" | "legacy";

export interface StoredAuth {
  mode: AuthMode;
  token: string;
  accountId?: string;
}

/** The only secret the UI persists. Aura's production copy saves it to a file;
 *  for this port we keep it in the webview's localStorage, which Tauri stores
 *  under the app data dir. Discord mode keeps a bearer `aura_` token; legacy
 *  mode keeps a fixed account_id + api token pair. */
export function saveDiscordAuth(token: string) {
  localStorage.setItem("aura.mode", "discord");
  localStorage.setItem("aura.token", token);
  localStorage.removeItem("aura.acct");
}

export function saveLegacyAuth(accountId: string, token: string) {
  localStorage.setItem("aura.mode", "legacy");
  localStorage.setItem("aura.token", token);
  localStorage.setItem("aura.acct", accountId);
}

export function loadAuth(): StoredAuth | null {
  const mode = localStorage.getItem("aura.mode");
  const token = localStorage.getItem("aura.token");
  if (!mode || !token) return null;
  if (mode === "legacy") {
    const accountId = localStorage.getItem("aura.acct");
    if (!accountId) return null;
    return { mode: "legacy", token, accountId };
  }
  return { mode: "discord", token };
}

export function clearAuth() {
  ["aura.mode", "aura.token", "aura.acct"].forEach((k) =>
    localStorage.removeItem(k),
  );
}
