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
  /** "" (no Tailscale), "ok" or "rerouted" — aura-core 26.3+. */
  tailscale: string;
}

export interface HelperInfo {
  installed: boolean;
  version: string | null;
  outdated: boolean;
  bundled_version: string;
}

export const appMeta = () =>
  call<{ version: string; api_base: string }>("app_meta");

export const authStart = () => call<AuthStart>("auth_start");
export const authPoll = (loginId: string, loginSecret: string) =>
  call<AuthPoll>("auth_poll", { login_id: loginId, login_secret: loginSecret });
export const openBrowser = (url: string) => call<void>("open_browser", { url });

export const openSession = (token: string) =>
  call<SessionInfo>("open_session", { token });
export const licenseSession = (key: string) =>
  call<SessionInfo>("license_session", { key });
export const readLicenseFile = (path: string) => call<string>("read_license_file", { path });
export const legacySession = (accountId: string, token: string) =>
  call<SessionInfo>("legacy_session", { account_id: accountId, token });
export const heartbeat = (sessionId: string, delta = 0) =>
  call<boolean>("heartbeat", { session_id: sessionId, delta });
export const closeSession = (sessionId: string) =>
  call<void>("close_session", { session_id: sessionId });
/** The newer version available for this install, or null when up to date. */
export const checkUpdate = () => call<string | null>("check_update");
/** Downloads, verifies and installs the update, then restarts Aura. */
export const installUpdate = () => call<void>("install_update");

export const autostartEnabled = () => call<boolean>("autostart_enabled");
export const setAutostart = (enabled: boolean) => call<void>("set_autostart", { enabled });

/** Traffic that skips the tunnel (Settings → Split tunneling). */
export interface SplitTunnel {
  bypass_lan: boolean;
  /** IPv4 addresses, IPv4 ranges (/8 to /32) and domains. */
  bypass: string[];
}

export const MAX_BYPASS_ENTRIES = 128;

export function loadSplitTunnel(): SplitTunnel {
  try {
    const raw = JSON.parse(localStorage.getItem("aura.split") ?? "null");
    if (raw && typeof raw === "object") {
      return {
        bypass_lan: raw.bypass_lan === true,
        bypass: Array.isArray(raw.bypass) ? raw.bypass.filter((x: unknown) => typeof x === "string") : [],
      };
    }
  } catch {
    // Fall through to the default.
  }
  return { bypass_lan: false, bypass: [] };
}

export function saveSplitTunnel(split: SplitTunnel) {
  localStorage.setItem("aura.split", JSON.stringify(split));
}

const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const BYPASS_IP = new RegExp(`^${IPV4}(?:/(?:[89]|[12]\\d|3[0-2]))?$`);
const BYPASS_DOMAIN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}\.?$/;

/** Splits the editor text into entries; returns the lines that won't parse. */
export function parseBypassList(text: string): { entries: string[]; invalid: string[] } {
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    const value = line.replace(/#.*/, "").trim().toLowerCase();
    if (!value) continue;
    if (BYPASS_IP.test(value) || BYPASS_DOMAIN.test(value)) {
      if (!entries.includes(value)) entries.push(value);
    } else {
      invalid.push(line.trim());
    }
  }
  return { entries, invalid };
}

export const coreStart = (
  auto: boolean,
  selected: ServerInfo,
  servers: ServerInfo[],
  preferIp: boolean,
  split: SplitTunnel,
) => call<string>("core_start", { auto, selected, servers, prefer_ip: preferIp, split });
export const coreStop = () => call<boolean>("core_stop");
export const coreStatus = () => call<CoreStatus>("core_status");
export const coreStats = () => call<CoreStats>("core_stats");
export const coreLog = () => call<string>("core_log");
export const coreHelper = () => call<HelperInfo>("core_helper");
export const probeServers = (servers: ServerInfo[], preferIp: boolean) =>
  call<Record<string, number>>("probe_servers", { servers, prefer_ip: preferIp });
export const coreInstall = () => call<void>("core_install");
export const coreUninstall = () => call<void>("core_uninstall");

export const usageMonthUsed = (accountId: string) =>
  call<number>("usage_month_used", { account_id: accountId });
export const usageAdd = (accountId: string, delta: number) =>
  call<void>("usage_add", { account_id: accountId, delta });

export type AuthMode = "license" | "discord" | "legacy";

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

export function saveLicenseAuth(key: string) {
  localStorage.setItem("aura.mode", "license");
  localStorage.setItem("aura.token", key);
  localStorage.removeItem("aura.acct");
}

/** Pull an `AURA-XXXXX-…` key out of pasted text or a license file's contents. */
export function extractLicenseKey(text: string): string | null {
  const m = text.toUpperCase().match(/AURA(?:[\s-]*[0-9A-Z]{5}){5}/);
  if (!m) return null;
  const body = m[0].slice(4).replace(/[^0-9A-Z]/g, "");
  return `AURA-${body.match(/.{5}/g)!.join("-")}`;
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
  return { mode: mode === "license" ? "license" : "discord", token };
}

export function clearAuth() {
  ["aura.mode", "aura.token", "aura.acct"].forEach((k) =>
    localStorage.removeItem(k),
  );
}
