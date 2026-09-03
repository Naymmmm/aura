// Typed bridge to the Rust commands. Mirrors Aura's Dart services, but the
// network/filesystem/engine work now lives in Rust; the React UI holds state.

import { invoke } from "@tauri-apps/api/core";

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
  invoke<{ version: string; api_base: string }>("app_meta");

export const authStart = () => invoke<AuthStart>("auth_start");
export const authPoll = (loginId: string, loginSecret: string) =>
  invoke<AuthPoll>("auth_poll", { login_id: loginId, login_secret: loginSecret });
export const openBrowser = (url: string) => invoke<void>("open_browser", { url });

export const openSession = (token: string) =>
  invoke<SessionInfo>("open_session", { token });
export const legacySession = (accountId: string, token: string) =>
  invoke<SessionInfo>("legacy_session", { account_id: accountId, token });
export const heartbeat = (sessionId: string, delta = 0) =>
  invoke<boolean>("heartbeat", { session_id: sessionId, delta });
export const closeSession = (sessionId: string) =>
  invoke<void>("close_session", { session_id: sessionId });
export const checkUpdate = () => invoke<string | null>("check_update");

export const coreStart = (
  auto: boolean,
  selected: ServerInfo,
  servers: ServerInfo[],
  preferIp: boolean,
  killSwitch: boolean,
  exceptions: string[],
) =>
  invoke<string>("core_start", {
    auto,
    selected,
    servers,
    prefer_ip: preferIp,
    kill_switch: killSwitch,
    exceptions,
  });
export const coreStop = () => invoke<boolean>("core_stop");
export const coreStatus = () => invoke<CoreStatus>("core_status");
export const coreStats = () => invoke<CoreStats>("core_stats");
export const coreLog = () => invoke<string>("core_log");

export const usageMonthUsed = (accountId: string) =>
  invoke<number>("usage_month_used", { account_id: accountId });
export const usageAdd = (accountId: string, delta: number) =>
  invoke<void>("usage_add", { account_id: accountId, delta });

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
