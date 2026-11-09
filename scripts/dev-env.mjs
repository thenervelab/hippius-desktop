#!/usr/bin/env node
//
// Make sure `src-tauri/.env` exists before a Tauri build reads it.
//
// `tauri.conf.json` lists `.env` as a bundle resource and `main.rs` loads it with dotenvy, so
// the file has to be there even when it sets nothing: bundling a missing resource fails the
// build. It is gitignored, so a fresh clone has none.
//
// Everything it can carry is now optional — `HIPPIUS_INDEXER_URL` and
// `HIPPIUS_CONSOLE_BASE_URL`, both of which default sensibly. So this creates the file from
// the committed template and stops; there is nothing to resolve and nothing to fail on.
//
// It used to do considerably more. `src-tauri/.env` had to carry `INDEXER_API_KEY`, without
// which every indexer-backed screen rendered a zero instead of an error, so this script
// resolved that key from the environment or by reading it back out of an installed Hippius
// build — which worked because the same key shipped inside every release and could be lifted
// from any of them. The indexer now authenticates the logged-in user instead
// (`src-tauri/src/api/indexer.rs`), so there is no shared key to distribute, harvest, or
// forget.
//
// Node rather than bash because `pnpm tauri:dev` runs this on every start, and a bash wrapper
// makes the project's primary dev command fail outright on a Windows machine without Git Bash
// on PATH.
//
// Usage:
//   node scripts/dev-env.mjs          # create src-tauri/.env if it is missing
//   node scripts/dev-env.mjs --soft   # identical; accepted so `pnpm tauri:dev` need not change

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = join(repoRoot, "src-tauri", ".env");
  const template = join(repoRoot, "src-tauri", ".env.example");

  if (existsSync(envFile)) {
    return 0;
  }

  if (existsSync(template)) {
    copyFileSync(template, envFile);
  } else {
    // The template is committed, so this should not happen — but an empty file still
    // satisfies the bundler, and failing the dev command over a missing comment block would
    // be worse than continuing.
    writeFileSync(envFile, "");
  }

  console.log("Created src-tauri/.env (every value in it is optional).");
  return 0;
}

// Only run when invoked as a script, so `main` stays importable by the unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { main };
