/**
 * WebdriverIO config for the macOS sync-widget smoke suite.
 *
 * Connects to the in-process W3C WebDriver server that `tauri-plugin-webdriver`
 * exposes on 127.0.0.1:4445 when the app is built with the `e2e-webdriver`
 * Cargo feature. The official `tauri-driver` can't drive macOS (no WKWebView
 * driver); this plugin can because it embeds the server in the app process.
 *
 * The harness page is served over plain HTTP (not the app's `tauri://`
 * protocol): a raw `cargo build` debug binary does not serve the embedded
 * frontend assets (Tauri debug builds expect a dev server), and the harness
 * needs no Tauri IPC anyway — it drives the widget through its own
 * `window.__e2ePushSyncFrame` bridge. So `onPrepare` starts a static server for
 * `out/` AND launches the app (for the WebDriver server); the spec navigates the
 * automation webview to the static page. `onComplete` tears both down — so
 * `pnpm e2e` is one command.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project is an ESM package (`"type": "module"`), so `__dirname` is not
// defined when WDIO loads this config — derive it from the module URL.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 4445;
const STATIC_PORT = 3101;
const OUT_DIR = path.resolve(HERE, "..", "out");
// Debug binary produced by `cargo build --features e2e-webdriver` (package name
// "Hippius" → target/debug/Hippius). Confirm the bin name on first run.
const APP_BINARY = path.resolve(HERE, "..", "src-tauri", "target", "debug", "Hippius");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

let appProcess: ChildProcess | null = null;
let staticServer: http.Server | null = null;

/** Minimal static server for the Next export: serves files under `out/`, with
 *  clean-URL (`/x` → `/x.html`) and directory-index fallback. Test-only; no
 *  path-traversal hardening beyond confining reads to OUT_DIR. */
function startStaticServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    staticServer = http.createServer(async (req, res) => {
      try {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        let file = path.normalize(path.join(OUT_DIR, decodeURIComponent(pathname)));
        if (!file.startsWith(OUT_DIR)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        if (file.endsWith(path.sep)) file = path.join(file, "index.html");
        if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
        const data = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    });
    staticServer.on("error", reject);
    staticServer.listen(STATIC_PORT, SERVER_HOST, () => resolve());
  });
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`WebDriver server ${host}:${port} not up within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: SERVER_HOST,
  port: SERVER_PORT,
  path: "/",
  // The harness is served over HTTP by the static server below.
  baseUrl: `http://${SERVER_HOST}:${STATIC_PORT}`,
  specs: [path.resolve(HERE, "specs", "**", "*.e2e.ts")],
  maxInstances: 1,
  // The plugin accepts but does not process capabilities (README) — an empty
  // object is the documented form. The testrunner needs at least one entry.
  capabilities: [{}],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  onPrepare: async () => {
    await startStaticServer();
    appProcess = spawn(APP_BINARY, [], { stdio: "inherit", env: { ...process.env } });
    await waitForPort(SERVER_HOST, SERVER_PORT, 60_000);
  },

  onComplete: () => {
    appProcess?.kill("SIGTERM");
    appProcess = null;
    staticServer?.close();
    staticServer = null;
  },
};
