import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

// Rust refuses the commands in `src-tauri/src/ipc_guard.rs` MAIN_WINDOW_ONLY
// unless the main window calls them. This test walks the code every other
// window loads (the tray popover and each capture window) and fails if any
// of it can call one of those commands, so a window never breaks at runtime
// because of the guard. It follows real imports (type-only imports are
// skipped, since they carry no code), so it over-approximates: a command in
// a shared module counts even if that window never reaches the call.

const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "src-tauri", "src", "ipc_guard.rs"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the repo root (src-tauri/src/ipc_guard.rs)");
})();

/** Every window except `main`, by the route it loads. */
const OTHER_WINDOW_ROUTES = [
  "tray-panel",
  "capture-overlay",
  "capture-controls",
  "capture-preview",
  "capture-camera",
  "capture-bubble-controls",
  "capture-pill-tip",
  "capture-area",
];

function mainWindowOnly(): string[] {
  const src = readFileSync(join(ROOT, "src-tauri", "src", "ipc_guard.rs"), "utf8");
  const start = src.indexOf("pub const MAIN_WINDOW_ONLY");
  const end = src.indexOf("];", start);
  expect(start, "MAIN_WINDOW_ONLY not found").toBeGreaterThan(-1);
  return [...src.slice(start, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of EXTENSIONS) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile() && /\.(ts|tsx|js)$/.test(path)) return path;
  }
  return null;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const IMPORT =
  /(?:import|export)\s+(type\s+)?[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const INVOKED = [
  /\b(?:invokeWithTimeout|invoke)\s*(?:<[^>]*>)?\s*\(\s*["']([a-z_][a-z0-9_]*)["']/g,
  /\bcommand:\s*["']([a-z_][a-z0-9_]*)["']/g,
];

/** Command name -> the files in the window's code that call it. */
function commandsReachableFrom(entry: string): Map<string, string[]> {
  const seen = new Set<string>();
  const stack = [join(ROOT, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of stripComments(readFileSync(file, "utf8")).matchAll(IMPORT)) {
      if (m[1]) continue;
      const next = resolveImport(file, m[2] ?? m[3] ?? m[4]);
      if (next && !next.includes("__tests__")) stack.push(next);
    }
  }
  const commands = new Map<string, string[]>();
  for (const file of seen) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const re of INVOKED) {
      for (const m of src.matchAll(re)) {
        commands.set(m[1], [...(commands.get(m[1]) ?? []), relative(ROOT, file)]);
      }
    }
  }
  return commands;
}

describe("main-window-only commands", () => {
  const guarded = mainWindowOnly();

  it("parses a non-trivial list from ipc_guard.rs", () => {
    expect(guarded).toContain("get_drive_mnemonic");
    expect(guarded.length).toBeGreaterThan(20);
  });

  it.each(OTHER_WINDOW_ROUTES)("the %s window calls none of them", (route) => {
    const entry = join("app", route, "page.tsx");
    const reachable = commandsReachableFrom(entry);
    // Sanity: the walk found the window's own commands.
    expect(reachable.size, `${route} reaches no invoke at all`).toBeGreaterThan(0);
    const refused = guarded
      .filter((command) => reachable.has(command))
      .map((command) => `${command} (${reachable.get(command)!.join(", ")})`);
    expect(refused, `${route} would be refused`).toEqual([]);
  });

  it("the theme provider every window mounts calls none of them", () => {
    const reachable = commandsReachableFrom(join("app", "lib", "theme-context.tsx"));
    expect(guarded.filter((command) => reachable.has(command))).toEqual([]);
  });

  it("the walk sees the main window's own use of a guarded command", () => {
    // Proves the walker would catch a guarded call: the recovery phrase is
    // revealed from the wallet auth context, which only the main window mounts.
    const reachable = commandsReachableFrom(join("app", "lib", "wallet-auth-context.tsx"));
    expect(reachable.has("get_drive_mnemonic")).toBe(true);
  });
});
