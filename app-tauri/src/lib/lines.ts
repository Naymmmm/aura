// ALL the meme copy in one place. Edit here, vibe everywhere.
// Port of Aura's `aura_lines.dart`. Each list maps to a real VPN state.

import type { AuthErrorKind } from "./api";

export const loggedOut = [
  "no aura on this machine yet. log in",
  "the aura is locked. you got the key?",
  "logged out. come back with creds",
  "aura: 0. login to ascend",
];

export const badCreds = [
  "wrong account id or token. check the copy-paste king",
  "those creds are not it. ask the admin",
  "bad creds. the aura rejected you (respectfully)",
];

export const accountExpired = [
  "your aura ran out. expired account. ask the admin for +30 days",
  "account expired. the aura has left the building",
  "expired. you need a refill, king",
];

export const accountDisabled = [
  "account disabled by the admin. go think about what you did",
  "your aura has been suspended. check with the admin",
];

export const noCredit = [
  "account created but no credit yet — the admin has to add days first",
  "your account exists but it has no aura yet. wait for the admin to add credit",
  "no credit loaded. the admin will unlock you. be patient king",
];

/** The Rules — shown on the login screen. Set by the owner. Non-negotiable. */
export const rules = [
  "No illegal stuff",
  "No piracy",
  "No torrenting",
  "Use your data wisely",
  "Pay on time",
];

export const poolExhausted = [
  "the cred pool is empty rn. try again in a bit",
  "all creds are leased. the aura is busy. retry king",
];

export const sessionGone = [
  "session expired server-side. log back in",
  "the session left without you. log in again",
];

/** One meme line for an auth failure kind (empty string when none). */
export function authError(kind: AuthErrorKind | null | undefined): string {
  switch (kind) {
    case "badCreds":
      return pick(badCreds);
    case "accountExpired":
      return pick(accountExpired);
    case "accountDisabled":
      return pick(accountDisabled);
    case "noCredit":
      return pick(noCredit);
    case "budgetExceeded":
      return pick(budgetOver);
    case "poolExhausted":
      return pick(poolExhausted);
    case "sessionGone":
      return pick(sessionGone);
    case "network":
      return "couldn't reach api.copal.run. check your internet fr";
    default:
      return "";
  }
}

export const disconnected = [
  "no aura right now. network is cringe",
  "L + ratio + no VPN",
  "your packets are rawdogging the ISP rn",
  "aura: 0. mogging potential: untapped",
  "connect and ascend. or don't. idc (connect)",
];

export const connecting = [
  "summoning the aura...",
  "lock in. tunneling...",
  "mogging the ISP as we speak",
  "packets, assemble. o7",
  "dialing romeo, juliet & mercutio...",
];

export const connected = [
  "AURA ON. you are him.",
  "+10000 aura. the ISP sees nothing",
  "certified mogger. traffic untouchable",
  "every packet is mogging now",
  "locked in. sigma mode engaged",
];

export const error = [
  "aura.exe has stopped working... skill issue",
  "we got ratio'd by the network",
  "the tunnel collapsed. not very skibidi of it",
  "connect failed. blame the cloud, not me fr",
  "the aura could not be summoned. try again king",
];

export const budget = [
  "the aura is a shared allowance. spend it wisely",
  "monthly aura tax: 100GB max",
  "aura credits are communal. don't be greedy",
];

export const budgetLow = [
  "aura running low. ration the packets",
  "we're at 80%+. lock in or log off",
  "the allowance is coughing. slow down king",
];

export const budgetOver = [
  "aura allowance: 0. tapped out fr",
  "budget blown. we'll be so back next month",
  "the aura is exhausted. skill issue on us (it's the budget)",
];

/** Pick a line from a list, stable-ish per day so it doesn't flicker. */
export function pick(lines: string[], seed?: number): string {
  const i = (seed ?? Date.now()) % lines.length;
  return lines[i];
}
