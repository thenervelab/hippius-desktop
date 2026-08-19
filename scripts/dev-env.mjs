#!/usr/bin/env node
//
// Make sure a local `pnpm tauri:dev` build has an indexer key.
//
// `src-tauri/.env` is gitignored, so a fresh clone gets no key. The app then
// renders every indexer-backed screen as a zero rather than an error — flat home
// charts, "0 B Used", empty billing charts — which reads as a data bug and costs
// an afternoon to trace. This resolves the key once and writes it to
// `src-tauri/.env`.
//
// Sources, in order:
//   1. $INDEXER_API_KEY in the environment
//   2. an installed Hippius app's bundled .env
//
// Harvesting from an installed app is deliberate, not a workaround: the same key
// ships inside every distributed build and is extractable from any of them
// (AUDIT_REDESIGN_2026-06-22.md M-9), so it is not a secret this script can leak.
//
// Node rather than bash because `pnpm tauri:dev` runs this on every start: a
// bash wrapper makes the project's primary dev command fail outright on a
// Windows machine without Git Bash on PATH, which is a hard block in service of
// a soft warning. Node is already required to run the script at all.
//
// Usage:
//   node scripts/dev-env.mjs          # fail if no key can be resolved
//   node scripts/dev-env.mjs --soft   # warn instead — used by `pnpm tauri:dev`,
//                                     # since everything except indexer data
//                                     # works without it

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY = "INDEXER_API_KEY";

/**
 * First `INDEXER_API_KEY` value in .env-shaped text; `""` when absent or blank.
 *
 * A trailing CR is stripped so a CRLF-authored file (or a secret pasted from
 * Windows) does not yield a key with an invisible character appended to it.
 */
export function parseIndexerKey(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith(`${KEY}=`)) {
      return line.slice(KEY.length + 1).replace(/\r$/, "").trim();
    }
  }
  return "";
}

/**
 * Set `INDEXER_API_KEY` in .env-shaped text, keeping every other line.
 *
 * Existing `INDEXER_API_KEY` lines are dropped rather than edited in place, so
 * a file that somehow carries two of them ends up with one. Everything else —
 * other vars, the template's comments — survives untouched.
 */
export function rewriteEnvText(existingText, key) {
  const kept = existingText
    .split("\n")
    .filter((line) => !line.startsWith(`${KEY}=`))
    .join("\n")
    .replace(/\n+$/, "");

  return kept === "" ? `${KEY}=${key}\n` : `${kept}\n${KEY}=${key}\n`;
}

/**
 * Where an installed Hippius build keeps its bundled `.env`, per platform.
 *
 * Tauri puts bundle resources next to the executable, so these track the
 * install layout of each target in `tauri.conf.json` (`dmg`/`app`, `deb`,
 * `msi`/`nsis`). A path that does not exist is simply skipped.
 */
export function installedEnvCandidates(platform, env) {
  const home = env.HOME ?? env.USERPROFILE ?? "";

  if (platform === "darwin") {
    return ["/Applications/Hippius.app/Contents/Resources/.env", join(home, "Applications/Hippius.app/Contents/Resources/.env")];
  }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean);
    return roots.map((root) => join(root, "Hippius", ".env"));
  }
  return ["/usr/lib/Hippius/.env", "/opt/Hippius/.env"];
}

/**
 * Pick the key to write: the environment first, then each candidate file's text
 * in order. Returns `null` when nothing carries one.
 *
 * Pure so the not-found path is testable — it is the branch that decides between
 * a warning and a failed build, and it cannot be exercised on a machine that
 * happens to have Hippius installed.
 */
export function resolveKey(envKey, sources) {
  if (envKey) {
    return { key: envKey, sourceDesc: `the ${KEY} environment variable` };
  }
  for (const { path, text } of sources) {
    const key = parseIndexerKey(text);
    if (key !== "") {
      return { key, sourceDesc: path };
    }
  }
  return null;
}

/** Read a file's text, or `""` when it is missing or unreadable. */
function readTextOrEmpty(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

const MISSING_KEY_MESSAGE = `no ${KEY} found. Indexer-backed screens (home charts, storage total, billing charts) will show zeros.
Fix it with any of:
  - install a Hippius release build, then re-run this script
  - export ${KEY}=... and re-run this script
  - ask a teammate for the value of the TAURI_ENV_FILE repository secret`;

function main(argv, env) {
  const soft = argv.includes("--soft");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = join(repoRoot, "src-tauri", ".env");

  if (parseIndexerKey(readTextOrEmpty(envFile)) !== "") {
    console.log(`src-tauri/.env already has an ${KEY}.`);
    return 0;
  }

  const sources = installedEnvCandidates(process.platform, env).map((path) => ({ path, text: readTextOrEmpty(path) }));
  const resolved = resolveKey(env[KEY] ?? "", sources);

  if (resolved === null) {
    // Soft mode never blocks: everything except indexer data works without a
    // key, so a dev with no installed build can still run the app.
    console.error(`${soft ? "warning" : "error"}: ${MISSING_KEY_MESSAGE}`);
    return soft ? 0 : 1;
  }

  const { key, sourceDesc } = resolved;
  writeFileSync(envFile, rewriteEnvText(readTextOrEmpty(envFile), key));
  try {
    chmodSync(envFile, 0o600);
  } catch {
    // Best-effort: Windows has no POSIX mode bits to set.
  }

  console.log(`Wrote ${KEY} to src-tauri/.env from ${sourceDesc}.`);
  console.log("Restart the app if it is running — the key is cached for the process lifetime.");
  return 0;
}

// Only run when invoked as a script, so the helpers above stay importable by
// the unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2), process.env));
}
