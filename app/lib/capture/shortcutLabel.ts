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

export function formatAccelerator(accelerator: string, mac: boolean): string {
  const keys = acceleratorKeys(accelerator, mac);
  return mac ? keys.join("") : keys.join("+");
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
export function acceleratorFromEvent(e: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = /^(Key[A-Z]|Digit[0-9]|F[0-9]{1,2})$/.test(e.code) ? e.code.replace(/^(Key|Digit)/, "") : null;
  if (!key) return null;
  const mods = [
    e.ctrlKey ? "Control" : null,
    e.altKey ? "Alt" : null,
    e.shiftKey ? "Shift" : null,
    e.metaKey ? "Command" : null,
  ].filter((m): m is string => m !== null);
  return [...mods, key].join("+");
}
