// Localization: the engine's string tables (assets/strings.json, the nine
// StarHermit locales, English text as the key) in the interface language the
// runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's); the engine's fallback chain
// picks the table, regional tables holding only their differences. Every
// string drawn is looked up each frame, so a change shows at once. The
// account lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }
/** fn() after the interface language changed. */
export function onLocaleChange(fn: () => void): void { strings.onChange(() => fn()); }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function tr(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key translated with tr() where it is shown. */
export const N = (s: string): string => s;

const ACCOUNT = {
  signIn: "signIn", invite: "invite", inviteCopied: "inviteCopied", inviteFailed: "inviteFailed", signedOut: "signedOut",
  signedInAs: "signedInAs", lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted",
  lbNotPosted: "leaderboardNotPosted",
} as const;
export type PlatformKey = keyof typeof ACCOUNT;
/** An account line (the engine's) in the player's language. */
export function pt(key: PlatformKey, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }
