import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// IPC wire-contract guard. The frontend has NO codegen from the Rust types
// (no tauri-specta / ts-rs), so a renamed or removed `#[tauri::command]`, or a
// renamed emitted event, reaches the FE only at runtime — a rejected promise
// for a command nobody handles, or a listener that silently never fires (the
// "hides an outage" failure mode). These pure string-set cross-checks turn that
// class of drift into a CI failure with no running app.
//
// Scope (deliberate, per the FE-testing evaluation): this guards NAMES, not
// payload SHAPES. A command that still exists but starts returning a different
// struct sails through — that needs Rust-side auto-emitted fixtures (tracked
// follow-up). Name drift is the highest-FREQUENCY regression; shape drift is
// rarer and caught by the Rust-side serde wire pins.
//
// Known limits of a string-set parse: a command invoked through a non-literal
// (a variable command name) or registered via a macro is invisible here. The
// guard is strong, not total; keep it alongside the Rust serde pins.

// ── Repo-root resolution ────────────────────────────────────────────────────
// Vitest runs from the repo root, but walk up defensively so the test is robust
// to being invoked from a subdirectory.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "src-tauri", "src", "main.rs"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "ipcContract: could not locate repo root (no src-tauri/src/main.rs found walking up from cwd)"
  );
}

const ROOT = findRepoRoot();

// ── File walking ────────────────────────────────────────────────────────────
function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...walk(full, accept));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

// Strip comments so a doc-comment example like `invoke("bond", ...)` is not
// mistaken for a real call site. Block comments first, then line comments —
// the `[^:]` guard leaves `https://` URLs intact. A stray strip can only DROP a
// scanned call (making the guard more permissive), never invent a false one.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Frontend source the app actually ships — excludes tests, the test-utils mock
// (its example strings are not real IPC calls), and the e2e harness.
function frontendSourceFiles(): string[] {
  return walk(join(ROOT, "app"), (p) => {
    if (!/\.(ts|tsx)$/.test(p)) return false;
    if (/\.test\.(ts|tsx)$/.test(p)) return false;
    if (p.includes(`${join("app", "lib", "test-utils")}`)) return false;
    if (p.includes(`${join("app", "e2e")}`)) return false;
    return true;
  }).map((p) => stripComments(readFileSync(p, "utf8")));
}

function rustSourceFiles(): string[] {
  return walk(join(ROOT, "src-tauri", "src"), (p) => p.endsWith(".rs")).map((p) =>
    readFileSync(p, "utf8")
  );
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** Commands registered in `tauri::generate_handler![ ... ]` in main.rs. */
function registeredCommands(): Set<string> {
  const main = readFileSync(join(ROOT, "src-tauri", "src", "main.rs"), "utf8");
  const start = main.indexOf("generate_handler![");
  expect(start, "generate_handler![ not found in main.rs").toBeGreaterThan(-1);
  const end = main.indexOf("]);", start);
  expect(end, "generate_handler! close ]); not found").toBeGreaterThan(start);
  const block = main.slice(start + "generate_handler![".length, end);

  const commands = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, ""); // strip trailing // comments
    for (const token of line.split(",")) {
      const t = token.trim();
      // Entries are bare idents or fully-qualified paths
      // (`crate::auth::login`); the registered command name is the final
      // path segment.
      if (!/^[A-Za-z_][\w:]*$/.test(t)) continue;
      const name = t.split("::").pop();
      if (name) commands.add(name);
    }
  }
  return commands;
}

/** Command names the FE passes as a string literal to invoke / invokeWithTimeout. */
function invokedCommands(): Set<string> {
  // `invokeWithTimeout` listed first so the alternation matches the longer name
  // before the `invoke` substring inside it.
  const re =
    /\b(?:invokeWithTimeout|invoke)\s*(?:<[^>]*>)?\s*\(\s*["']([a-z_][a-z0-9_]*)["']/g;
  const names = new Set<string>();
  for (const src of frontendSourceFiles()) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

/** Event names Rust can emit: the const registries ∪ literal emits. */
function rustEmittedEvents(): Set<string> {
  const names = new Set<string>();
  // Canonical const registries: `pub const NAME: &str = "value";`. One per
  // module that owns events — `sync/projection/events.rs` and `vpn/events.rs`.
  // (The VPN commands emit via these consts, not quoted literals, so the
  // literal-emit window scan below would miss them.)
  const registryFiles = [
    join(ROOT, "src-tauri", "src", "sync", "projection", "events.rs"),
    join(ROOT, "src-tauri", "src", "vpn", "events.rs"),
  ];
  for (const file of registryFiles) {
    const events = readFileSync(file, "utf8");
    for (const m of events.matchAll(/pub const [A-Z_0-9]+:\s*&str\s*=\s*"([^"]+)"/g)) {
      names.add(m[1]);
    }
  }
  // Literal emits not routed through a const (migration_progress,
  // recovery_progress, block_number_updated, …). Match any event-shaped quoted
  // string on a line that calls `.emit*` — a superset that only ever makes the
  // subset assertion MORE permissive, never falsely failing, while the const
  // registry above still pins every renamed canonical event exactly.
  const emitCall = /\.emit(?:_to|_all|_filter)?\s*\(/g;
  const quoted = /"([a-z][a-z0-9_:.-]*)"/g;
  for (const src of rustSourceFiles()) {
    // Window 200 chars past each `.emit(` so a multi-line emit (the call on one
    // line, the event-name arg on the next) is captured. `emit_to(window,
    // "event", …)` puts the event in the 2nd arg, so all in-window quoted
    // strings are collected — over-capture only widens the permissive set.
    for (const m of src.matchAll(emitCall)) {
      const window = src.slice(m.index, m.index + 200);
      for (const q of window.matchAll(quoted)) names.add(q[1]);
    }
  }
  return names;
}

/** Event names the FE itself emits (FE→FE cross-window, e.g. `hippius:*`). */
function feEmittedEvents(): Set<string> {
  const re = /\bemit\s*(?:<[^>]*>)?\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_:.-]*)["']/g;
  const names = new Set<string>();
  for (const src of frontendSourceFiles()) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

/** Event names the FE listens for. */
function listenedEvents(): Set<string> {
  const re = /\blisten\s*(?:<[^>]*>)?\s*\(\s*["']([a-zA-Z][a-zA-Z0-9_:.-]*)["']/g;
  const names = new Set<string>();
  for (const src of frontendSourceFiles()) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

// Commands the FE references but Rust does not register YET — known, tracked
// gaps, NOT silent drift. The VPN/Nebula surface is gated off behind
// `VPN_FEATURE_ENABLED=false` (see CLAUDE.md "UI feature flags"): the invoke
// call sites exist in the gated-off menu code but the backend commands are not
// wired up ("Command get_vpn_status not found"). Re-enabling VPN must register
// these and delete them from this set. The staleness check below fails the test
// if an entry is ever registered or no longer invoked, so this list cannot rot.
const KNOWN_UNREGISTERED_COMMANDS = new Set<string>([
  "get_vpn_status",
  "toggle_vpn_status",
  "get_nebula_ip",
  "get_nebula_stats",
  "get_autoconnect_status",
  "toggle_autoconnect_status",
]);

// Commands the FE dispatches through a NON-literal (a `Record<Action, string>`
// lookup in FailedFilesModal), invisible to the string-literal scan above. List
// them so a Rust rename still trips CI; update this list if that table changes.
const KNOWN_TABLE_DISPATCHED_COMMANDS = [
  "sp_retry_file",
  "sp_skip_file",
  "sp_exclude_file",
];

describe("IPC command contract (FE invoke ↔ Rust generate_handler!)", () => {
  it("parses a sane number of registered commands and FE call sites", () => {
    // Tripwire: if a parser silently starts matching nothing (e.g. the
    // generate_handler! block moves or the invoke pattern changes), these
    // floors fail loudly instead of the subset check passing vacuously.
    expect(registeredCommands().size).toBeGreaterThan(150);
    expect(invokedCommands().size).toBeGreaterThan(100);
  });

  it("every FE-invoked command is registered in the Rust handler", () => {
    const registered = registeredCommands();
    const invoked = invokedCommands();
    const missing = [...invoked]
      .filter((c) => !registered.has(c) && !KNOWN_UNREGISTERED_COMMANDS.has(c))
      .sort();
    expect(
      missing,
      `FE invokes commands with no #[tauri::command] in generate_handler![]: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("table-dispatched commands (non-literal invoke) are registered in Rust", () => {
    const registered = registeredCommands();
    const missing = KNOWN_TABLE_DISPATCHED_COMMANDS.filter((c) => !registered.has(c));
    expect(
      missing,
      `table-dispatched commands missing from generate_handler![]: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("the KNOWN_UNREGISTERED_COMMANDS allow-list has not gone stale", () => {
    const registered = registeredCommands();
    const invoked = invokedCommands();
    for (const c of KNOWN_UNREGISTERED_COMMANDS) {
      expect(
        invoked.has(c),
        `"${c}" is allow-listed but the FE no longer invokes it — drop it from KNOWN_UNREGISTERED_COMMANDS`
      ).toBe(true);
      expect(
        registered.has(c),
        `"${c}" is now registered in Rust — drop it from KNOWN_UNREGISTERED_COMMANDS`
      ).toBe(false);
    }
  });
});

describe("IPC event contract (FE listen ↔ Rust/FE emit)", () => {
  it("parses a sane number of Rust-emitted events", () => {
    expect(rustEmittedEvents().size).toBeGreaterThan(20);
  });

  it("every FE-listened event is emitted by Rust or the FE", () => {
    const emitted = new Set([...rustEmittedEvents(), ...feEmittedEvents()]);
    const listened = listenedEvents();
    const orphans = [...listened].filter((e) => !emitted.has(e)).sort();
    expect(
      orphans,
      `FE listens for events nothing emits (renamed/removed event ⇒ dead listener): ${orphans.join(", ")}`
    ).toEqual([]);
  });
});
