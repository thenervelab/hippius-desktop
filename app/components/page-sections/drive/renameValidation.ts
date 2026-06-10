// Pure helpers for the rename dialog. UI-side validation exists only for
// instant feedback — the Rust `rename_entry` command re-validates and is
// authoritative (same limits: non-empty, no separators, 255 bytes).

/** Final path component of a (possibly relative) name. */
export function basenameOf(name: string): string {
  const idx = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/** Lowercased extension without the dot; "" for none or dotfiles. */
export function extensionOf(name: string): string {
  const base = basenameOf(name);
  const dot = base.lastIndexOf(".");
  // dot > 0 (not >= 0) so dotfiles like ".env" read as extensionless —
  // renaming ".env" to ".env.bak" should warn, not the other way around.
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// DOS device names are reserved on Windows even with an extension
// ("con.txt"). Mirrors the Rust validator's WINDOWS_RESERVED list.
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Validation message for a proposed name, or `null` when acceptable.
 * An unchanged name returns `null` here — the dialog disables its confirm
 * button via `isUnchangedName` instead of showing an error for it.
 */
export function getRenameValidationError(rawName: string): string | null {
  const name = rawName.trim();
  if (!name) return "Name cannot be empty";
  if (name === "." || name === "..") return "That name is not allowed";
  if (/[/\\\0]/.test(name)) return "Name cannot contain / or \\";
  // Cross-platform safety (drives sync to Windows devices): ':' is the NTFS
  // stream separator and trailing dots are invalid there.
  if (name.includes(":") || name.endsWith(".")) {
    return "Name cannot contain ':' or end with '.'";
  }
  if (WINDOWS_RESERVED.has((name.split(".")[0] ?? "").toUpperCase())) {
    return "That name is reserved by the operating system";
  }
  if (new TextEncoder().encode(name).length > 255) {
    return "Name is too long";
  }
  return null;
}

/** True when the trimmed proposal equals the current basename. */
export function isUnchangedName(rawName: string, currentBasename: string): boolean {
  return rawName.trim() === currentBasename;
}

/** True when renaming a file would change its extension (never for folders). */
export function wouldChangeExtension(
  rawName: string,
  currentBasename: string,
  isFolder: boolean,
): boolean {
  if (isFolder) return false;
  return extensionOf(rawName.trim()) !== extensionOf(currentBasename);
}
