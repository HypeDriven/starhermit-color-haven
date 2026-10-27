// Localization: the browser build's string tables (js/strings.js through
// js/i18n.js, the nine StarHermit locales, English text as the key) in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replaced the game's own
// Language menu (sh-language.js). The account lines are
// js/platform-strings.js's tables.
import { onPreferencesChange, preferences } from "starhermit:engine";
import { loadClassic } from "starhermit:script";
import * as ui from "starhermit:ui";
import { fmtPlatform, platformStrings } from "../js/platform-strings.js";

loadClassic("js/strings.js");
loadClassic("js/i18n.js");

interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
const I18n = (globalThis as unknown as { HVI18N: I18nApi }).HVI18N;

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = I18n.locales.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
const listeners = new Set<() => void>();
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = I18n.setLocale(next);
  ui.setLanguage(locale);
  for (const fn of listeners) fn();
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
/** fn() after the interface language changed. */
export function onLocaleChange(fn: () => void): void { listeners.add(fn); }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function tr(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key translated with tr() where it is shown. */
export const N = (s: string): string => s;

export type PlatformKey = "signIn" | "invite" | "inviteCopied" | "inviteFailed" | "signedOut" | "signedInAs" | "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted";
/** An account line (js/platform-strings.js) in the player's language. */
export function pt(key: PlatformKey, vars?: Vars): string {
  const table = platformStrings(locale) as Record<string, string>;
  return fmtPlatform(table[key] ?? key, vars);
}
