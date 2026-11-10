// Bits shared by jump and procs: hint letters, rows, space headers.
// A mod can only import from its own folder, so each one carries a copy of this file.
// Edit the one in run/ and copy it over.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, shared } from "herdr";

/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").KeyEvent} KeyEvent */
/** @typedef {import("gpui-kit").ClickEvent} ClickEvent */
/** @typedef {import("gpui-kit").NativeElement} El */
/** @typedef {import("herdr").SpaceInfo} SpaceInfo */
/** @typedef {Record<string, Color>} Theme */
/** @typedef {{ at: number, typed: string }} NavState */
/** @typedef {{ hint?: string }} Hinted */
/** @typedef {(e: ClickEvent, cx: Context) => void} Click */
/** @typedef {{ spaces: Record<string, string>, tabs: Record<string, string> }} HintConfig */

/** The app's theme colors, typed as colors the builders accept. @returns {Theme} */
export function colors() {
  return /** @type {Theme} */ (theme());
}

/**
 * The islands layout's main panel fill: the theme background at islands' "main_opacity"
 * (solid when islands isn't installed). shade < 1 darkens it, 0.8 is 20% darker.
 * more adds to the opacity, so 0.1 makes it a bit more solid than the panel.
 * @param {Theme} t @param {number} [shade] @param {number} [more] @returns {Color}
 */
export function panelFill(t, shade = 1, more = 0, base = t.background) {
  const c = String(base), o = shared("islands.mainOpacity");
  if (!/^#[0-9a-f]{6}$/i.test(c)) return base;
  const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
  const rgb = [1, 3, 5].map((i) => hex(parseInt(c.slice(i, i + 2), 16) * shade)).join("");
  const a = typeof o === "number" ? Math.min(1, o + more) : 1;
  const alpha = a < 1 ? hex(Math.max(0, a) * 255) : "";
  return /** @type {Color} */ (`#${rgb}${alpha}`);
}

// Home row first, then everything else. One letter each until we run out, then pairs.
const HOME = "asdfghjkl";
const REST = "qwertyuiopzxcvbnm";

/**
 * Hand out a hint per item, skipping `reserved` letters. `preferred[i]` is what
 * the user asked for in their config and wins if it's free. The rest fill in
 * from the alphabet, never starting with a preferred letter, so typing yours
 * always lands where you expect.
 * @param {number} count
 * @param {string} [reserved]
 * @param {(string | null | undefined)[]} [preferred]
 * @returns {string[]}
 */
export function hints(count, reserved = "", preferred = []) {
  /** @type {(string | null)[]} */
  const out = new Array(count).fill(null);
  /** @type {Set<string>} */
  const taken = new Set();
  for (let i = 0; i < count; i++) {
    const p = String(preferred[i] ?? "").toLowerCase();
    if (/^[a-z]+$/.test(p) && ![...p].some((c) => reserved.includes(c)) && !taken.has(p)) { out[i] = p; taken.add(p); }
  }
  // If someone picked "ab", nobody else gets plain "a" or typing it would stop there.
  const starts = new Set([...taken].map((h) => h[0]));
  const letters = [...(HOME + REST)].filter((c) => !reserved.includes(c) && !starts.has(c));
  const need = out.filter((h) => !h).length;
  /** @type {string[]} */
  const pool = [];
  if (need <= letters.length) pool.push(...letters);
  else for (const a of letters) for (const b of letters) pool.push(a + b);
  let next = 0;
  return out.map((h) => h ?? pool[next++] ?? "");
}

export const SPIN = "mods/workspace-chrome/spinner.svg";

/**
 * The colored dot in front of a row.
 * @param {Theme} t
 * @param {string | null} status working | blocked | done | idle | running | exited | null
 */
export function glyph(t, status) {
  const slot = () => h_flex().w(12).flex_none();
  if (status === "working") return slot().child(svg(SPIN).size(12).flex_none().text_color(t.working).spin(900));
  // Running green, dead red. Agent statuses use whatever the theme says.
  /** @type {Record<string, Color>} */
  const tone = { blocked: t.blocked, done: t.done, idle: t.idle, running: t.ansi2, exited: t.ansi1 };
  const color = tone[status ?? ""] ?? t.dim;
  const ch = status === "idle" ? "○" : status ? "●" : "·";
  return slot().text_color(color).child(ch);
}

/**
 * The hint badge at a row's start.
 * @param {Theme} t
 * @param {string} hint
 * @param {string} typed the letters typed so far, shown highlighted
 * @param {boolean} [pinned] the person chose this letter, so it's drawn in the accent color
 */
export function badge(t, hint, typed, pinned = false) {
  const lit = typed && hint.startsWith(typed) ? typed.length : 0;
  return h_flex()
    .flex_none()
    .min_w(22)
    .h(18)
    .px(5)
    .items_center()
    .justify_center()
    .rounded(4)
    .bg(t.raised)
    .border_1()
    .border_color(pinned ? t.accent : t.border)
    .text_size(11)
    .font_semibold()
    .children([...hint].map((c, i) => div().text_color(i < lit || pinned ? t.accent : t.muted).child(c)));
}

export const ROW_H = 30;

/**
 * A row's shell: its letter first, an accent bar when selected. Callers add the rest.
 * @param {Theme} t
 * @param {{ id: string, hint: string, typed: string, pinned?: boolean, on: boolean, onClick: Click }} r
 */
export function row(t, { id, hint, typed, pinned, on, onClick }) {
  return h_flex()
    .id(id)
    .relative()
    .w_full()
    .h(ROW_H)
    .flex_none()
    .px(10)
    .gap(10)
    .items_center()
    .rounded(7)
    .when(on, (el) => el.bg(t.selected))
    .cursor_pointer()
    .hover((s) => s.bg(on ? t.selected : faint(t.hover)))
    .on_click(onClick)
    .when(on, (el) => el.child(div().absolute().left(0).top(6).w(3).h(18).rounded(2).bg(t.accent)))
    .child(badge(t, hint, typed, pinned || on));
}

/** A hover well below the selected row's weight. @param {Color} c @returns {Color} */
const faint = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? /** @type {Color} */ (c + "66") : c);

/** A space's colored square. @param {SpaceInfo} s @param {Color} color */
export function avatar(s, color) {
  return h_flex().size(18).flex_none().rounded(5).bg(color).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?");
}

/** @param {Theme} t @param {SpaceInfo} s */
export function spaceName(t, s) {
  return div().flex_none().max_w(200).truncate().font_semibold().text_color(t.foreground).child(s.name);
}

/**
 * Tells spaces with the same name apart: the folder, plus the branch when the folders match too.
 * @param {SpaceInfo[]} all
 * @param {SpaceInfo} s
 * @param {string} home
 */
export function spaceNote(all, s, home) {
  const same = all.filter((o) => o.id !== s.id && o.name === s.name);
  if (!same.length) return "";
  const folder = s.folder.replace(home, "~");
  return same.some((o) => o.folder === s.folder) && s.branch ? `${folder} · ${s.branch}` : folder;
}

/**
 * Shared key handling for the list. Mutates `state` and tells the caller what
 * happened: "done" (we ate it), "hit" (a hint matched), "act" (enter),
 * "close" (escape), or null (not ours).
 * @param {NavState} state
 * @param {KeyEvent} e
 * @param {Hinted[]} items every hinted thing in order
 * @returns {"done" | "hit" | "act" | "close" | null}
 */
export function navigate(state, e, items) {
  const k = e.key;
  if (k === "escape") {
    if (state.typed) { state.typed = ""; return "done"; }
    return "close";
  }
  // ctrl-n / ctrl-p for the emacs and readline crowd.
  if (e.keystroke === "ctrl-n") { state.at = Math.min(items.length - 1, state.at + 1); state.typed = ""; return "done"; }
  if (e.keystroke === "ctrl-p") { state.at = Math.max(0, state.at - 1); state.typed = ""; return "done"; }
  if (e.modifiers.control || e.modifiers.alt || e.modifiers.platform) return null;
  // j/k are reserved in both mods, so they're safe to use for movement here.
  if (k === "down" || k === "j") { state.at = Math.min(items.length - 1, state.at + 1); state.typed = ""; return "done"; }
  if (k === "up" || k === "k") { state.at = Math.max(0, state.at - 1); state.typed = ""; return "done"; }
  if (k === "enter") return "act";
  if (/^[a-z]$/.test(k) && !e.modifiers.shift) {
    const typed = state.typed + k;
    const exact = items.findIndex((it) => it.hint === typed);
    if (exact >= 0) { state.at = exact; state.typed = ""; return "hit"; }
    if (items.some((it) => it.hint?.startsWith(typed))) { state.typed = typed; return "done"; }
    state.typed = "";
    return null;
  }
  return null;
}

// Same avatar colors the built-in sidebar uses, so spaces look the same everywhere.
/** @type {Record<string, Color>} */
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/**
 * @param {Theme} t
 * @param {SpaceInfo} s
 * @param {Record<string, string> | undefined} colors shared("space.colors")
 * @returns {Color}
 */
export function spaceColor(t, s, colors) {
  if (s.name === "~") return t.dim;
  const c = colors?.[s.id] ?? "ansi6";
  return c.startsWith("#") ? /** @type {Color} */ (c) : (MARK[c] ?? t[c]);
}

/**
 * The key hint line at the bottom.
 * @param {Theme} t
 * @param {[string, string][]} pairs key, what it does
 */
export function hintLine(t, pairs) {
  return h_flex()
    .flex_wrap()
    .gap(12)
    .text_size(11)
    .children(pairs.map(([k, what]) => h_flex().gap(4).child(div().text_color(t.accent).font_semibold().child(k)).child(div().text_color(t.dim).child(what))));
}

// Your own hint letters live in ~/.config/herdr-app/hints.json, shared by jump and procs:
//   { "spaces": { "Logos": "l" }, "tabs": { "Logos/Code": "c" } }
// Spaces by name, tabs as "space/tab". Reserved letters get ignored.
export const HINTS_FILE = "hints.json";

/**
 * @param {typeof import("herdr").readTextFile} readTextFile
 * @param {typeof import("herdr").appHome} appHome
 * @returns {Promise<HintConfig>}
 */
export async function readHintConfig(readTextFile, appHome) {
  try {
    const text = await readTextFile(appHome() + "/" + HINTS_FILE);
    const json = text ? JSON.parse(text) : {};
    return { spaces: json.spaces ?? {}, tabs: json.tabs ?? {} };
  } catch {
    return { spaces: {}, tabs: {} };
  }
}

