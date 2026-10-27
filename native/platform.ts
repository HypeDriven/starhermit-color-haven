// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey bests and stars, achievements, finished daily days,
//   illustrations finished, the guest id, the finished Learn lessons) is
//   the game's save (starhermit:storage `saves`): { v: 1, progress } on the
//   device and in the player's cloud slot, two devices' copies merged on a
//   conflict (js/store.js mergeProgress keeps the better of both). The slot
//   the browser build wrote (the JS SDK's zipped save.json holding
//   { progress }) shows as foreign and is merged in and replaced once;
// - the round in progress (Continue on the title) and the local
//   leaderboards stay on the device (`storage`, through the small
//   localStorage-like `ls` js/store.js takes), as the browser build kept
//   them in localStorage;
// - the game's own settings (Captions for sounds, the colour-vision-safe
//   palette, the left-handed tray, haptics) are `settings` (game.<key>,
//   synced with the account); the browser build's per-player settings are
//   migrated (those four), then removed. Volumes, graphics, reduced motion,
//   high contrast and text size are the runtime's Options;
// - the player's name, the invite link, posting a finished ranked round's
//   total to the high-score board through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS
//   SDK's submitScores did) and the platform's clock for the daily's date.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as S from "../js/store.js";

export type Progress = ReturnType<typeof S.defaultProgress> & { playerId?: string };
export interface Doc { v: number; progress: Progress }

/** localStorage's shape over the device's storage (js/store.js's snapshot and boards). */
export const ls = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};

// --- the save ------------------------------------------------------------------------------
let doc: Doc = { v: 1, progress: S.defaultProgress() };
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function progress(): Progress { return doc.progress; }
/** Writes the save (device at once, the account debounced by the runtime). */
export function persist(): void {
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}

/** Takes another document's progress in (merged with this device's); whether it changed. */
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(doc.progress);
  const next = S.mergeProgress(doc.progress, other.progress) as Progress;
  if (JSON.stringify(next) === before) return false;
  doc = { v: 1, progress: next };
  return true;
}

saves.onConflict((local, remote) => {
  const a = S.docFromSave(local?.data), b = S.docFromSave(remote.data);
  const merged = S.mergeProgress(a ? a.progress : S.defaultProgress(), b ? b.progress : S.defaultProgress());
  return { merged: { v: 1, progress: merged } as unknown as JsonValue };
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(S.docFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const changed = adopt(S.fromBrowserSave(old.text));
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's sync line: offline (a guest) | saving | synced | pending. */
export function syncState(): "offline" | "saving" | "synced" | "pending" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked" || st === "conflict") return "pending";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -------------------------------------------------------------------
export interface Settings { captions: boolean; cvdPalette: boolean; leftHanded: boolean; haptics: boolean; [key: string]: unknown }
export const settings: Settings = { ...(S.DEFAULT_SETTINGS as Settings) };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = S.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = S.checkSetting(key, value);
  if (v === undefined || store.get(key) !== undefined) return;
  try { store.set(key, v as JsonValue); settings[key] = v; settingsChanged(); } catch { /* keep the device's */ }
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: "captions" | "cvdPalette" | "leftHanded" | "haptics", value: boolean): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings keys: the game's options among
// them carry over (unless this game set them since), then all are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) {
    if (!S.BROWSER_SETTING_KEYS.includes(key)) continue;
    if (S.GAME_SETTING_KEYS.includes(key)) adoptSetting(key, store.legacy(key));
    store.removeLegacy(key);
  }
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = S.docFromSave(cur?.data);
  if (d) doc = d as Doc;
  else if (!cur) persist();
  for (const k of S.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!S.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player ----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
export function userId(): string | null { return player()?.userId ?? null; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number { return serverNow() ?? Date.now(); }

// --- the StarHermit leaderboard ------------------------------------------------------------
const BOARD_KEY = "colorhaven.board-id";
let boardId: string | null = null;
/** The high-score board's id: listed signed in, then kept on the device. */
async function highScoreBoard(): Promise<string | null> {
  if (boardId) return boardId;
  if (player()) {
    try {
      const list = await leaderboards.list();
      const b = list.find((x) => x.key === "high-score") ?? list[0];
      if (b) { boardId = b.id; try { storage.set(BOARD_KEY, b.id); } catch { /* full */ } }
    } catch { /* offline */ }
  }
  if (!boardId) { try { boardId = storage.getText(BOARD_KEY); } catch { boardId = null; } }
  return boardId;
}

/** Signed in only: post a completed ranked round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const id = await highScoreBoard();
    if (!id) return { posted: true, rank: null };
    const r = await leaderboards.entries(id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
