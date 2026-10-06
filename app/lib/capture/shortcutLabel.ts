/**
 * How a shortcut reads to the person pressing it. Rust stores Tauri
 * accelerators ("CommandOrControl+Shift+2"); a Mac shows them as symbols in
 * the system's order (⌃⌥⇧⌘), anything else as "Ctrl+Shift+2".
 */

const MAC_ORDER = ["CONTROL", "ALT", "SHIFT", "SUPER"] as const;
const MAC_SYMBOL: Record<(typeof MAC_ORDER)[number], string> = {
  CONTROL: "⌃",
  ALT: "⌥",
  SHIFT: "⇧",
  SUPER: "⌘",
};
const OTHER_NAME: Record<(typeof MAC_ORDER)[number], string> = {
  CONTROL: "Ctrl",
  ALT: "Alt",
  SHIFT: "Shift",
  SUPER: "Win",
};

function normaliseModifier(part: string, mac: boolean): (typeof MAC_ORDER)[number] | null {
  switch (part.toUpperCase()) {
    case "COMMANDORCONTROL":
    case "COMMANDORCTRL":
    case "CMDORCTRL":
    case "CMDORCONTROL":
      return mac ? "SUPER" : "CONTROL";
    case "COMMAND":
    case "CMD":
    case "SUPER":
    case "META":
      return "SUPER";
    case "CONTROL":
    case "CTRL":
      return "CONTROL";
    case "ALT":
    case "OPTION":
      return "ALT";
    case "SHIFT":
      return "SHIFT";
    default:
      return null;
  }
}

/** "Digit2" / "KeyC" / "2" → "2" / "C". */
function keyName(part: string): string {
  const m = /^(?:Digit|Key)(.+)$/.exec(part);
  return (m ? m[1] : part).toUpperCase();
}

/**
 * The shortcut as separate keys, modifiers first in the system's order, so
 * each can be drawn as its own keycap: ["⇧", "⌘", "2"] or ["Ctrl", "Shift", "2"].
 */
export function acceleratorKeys(accelerator: string, mac: boolean): string[] {
  const parts = accelerator.split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set<(typeof MAC_ORDER)[number]>();
  const keys: string[] = [];
  for (const part of parts) {
    const mod = normaliseModifier(part, mac);
    if (mod) mods.add(mod);
    else keys.push(keyName(part));
  }
  const ordered = MAC_ORDER.filter((m) => mods.has(m));
  return [...ordered.map((m) => (mac ? MAC_SYMBOL[m] : OTHER_NAME[m])), ...keys];
}

/** Whether this is a Mac, for the symbols. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

/**
 * An accelerator from a key press in the shortcut recorder, or `null` while
 * only modifiers are held (the recorder waits for the key). Uses `e.code`, so
 * Option+2 records "2", not the "™" it types.
 */
type KeyPress = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const SHORTCUT_KEY = /^(Key[A-Z]|Digit[0-9]|F[0-9]{1,2})$/;
const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^CapsLock$|^Fn$/;

function heldModifiers(e: KeyPress): string[] {
  return [
    e.ctrlKey ? "Control" : null,
    e.altKey ? "Alt" : null,
    e.shiftKey ? "Shift" : null,
    e.metaKey ? "Command" : null,
  ].filter((m): m is string => m !== null);
}

export function acceleratorFromEvent(e: KeyPress): string | null {
  const key = SHORTCUT_KEY.test(e.code) ? e.code.replace(/^(Key|Digit)/, "") : null;
  if (!key) return null;
  return [...heldModifiers(e), key].join("+");
}

/**
 * What the shortcut recorder makes of one key event, so it can answer every
 * press the way macOS's own recorder does: the modifiers held so far drawn
 * live, a finished shortcut saved, and a key it cannot use explained rather
 * than ignored. Rust still decides whether a finished shortcut is allowed.
 */
export type RecorderKey =
  | { kind: "modifiers"; accelerator: string }
  | { kind: "shortcut"; accelerator: string }
  | { kind: "unsupported" };

export function recorderKey(e: KeyPress): RecorderKey {
  if (MODIFIER_CODE.test(e.code)) return { kind: "modifiers", accelerator: heldModifiers(e).join("+") };
  const accelerator = acceleratorFromEvent(e);
  return accelerator ? { kind: "shortcut", accelerator } : { kind: "unsupported" };
}

/** Why a key cannot be a shortcut, in the recorder's own words. */
export const UNSUPPORTED_SHORTCUT_KEY = "Use a letter, a number or an F key, together with a modifier.";

/** The confirm key's name on this platform: "Return" on a Mac, "Enter" elsewhere. */
export function enterKeyName(mac = isMacPlatform()): string {
  return mac ? "Return" : "Enter";
}
