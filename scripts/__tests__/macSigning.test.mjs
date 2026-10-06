// scripts/lib/mac-signing.sh picks the identity `pnpm build:mac-local` signs
// with. Signing ad hoc when a real identity exists costs the Screen Recording
// grant on every rebuild, and a mistyped --identity must never quietly turn
// into an ad hoc build, so the selection is pinned here with canned
// `security find-identity` output (it runs on any OS with bash).

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/mac-signing.sh");

/** Run `fn args...` from the library with `input` on stdin, as the build script does. */
function call(fn, args = [], input = "") {
  const result = spawnSync("bash", ["-c", `set -euo pipefail; source "$0"; ${fn} "$@"`, lib, ...args], {
    input,
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

const DEV_A = "CC8FFE92913E230356705BE496CAFCD67DB1F765";
const DEV_B = "2BBE96E64ED7907C93E8E1BF5F0176FE5D1EE131";
const DEVID = "0123456789ABCDEF0123456789ABCDEF01234567";

const twoDevelopment = `  1) ${DEV_A} "Apple Development: someone@example.com (N54T89X52Z)"
  2) ${DEV_B} "Apple Development: Some One (XF9ZCZDXVP)"
     2 valid identities found
`;

const withDeveloperId = `  1) ${DEV_A} "Apple Development: someone@example.com (N54T89X52Z)"
  2) ${DEVID} "Developer ID Application: Example Ltd (TEAM123456)"
     2 valid identities found
`;

const none = "     0 valid identities found\n";

/** find-identity output → the identity select_signing_identity picks for `requested`. */
function pick(findIdentity, requested = "") {
  const parsed = call("parse_signing_identities", [], findIdentity).out;
  return call("select_signing_identity", [requested], parsed ? `${parsed}\n` : "");
}

describe("parse_signing_identities", () => {
  it("keeps the SHA-1 and the name of each identity, in order", () => {
    expect(call("parse_signing_identities", [], twoDevelopment).out.split("\n")).toEqual([
      `${DEV_A}\tApple Development: someone@example.com (N54T89X52Z)`,
      `${DEV_B}\tApple Development: Some One (XF9ZCZDXVP)`,
    ]);
  });

  it("reads nothing from an empty keychain", () => {
    expect(call("parse_signing_identities", [], none).out).toBe("");
  });
});

describe("select_signing_identity", () => {
  it("prefers Developer ID Application over Apple Development", () => {
    expect(pick(withDeveloperId).out).toBe(`${DEVID}\tDeveloper ID Application: Example Ltd (TEAM123456)`);
  });

  it("takes the first Apple Development identity when there are several", () => {
    expect(pick(twoDevelopment).out).toBe(`${DEV_A}\tApple Development: someone@example.com (N54T89X52Z)`);
  });

  it("falls back to ad hoc only when there is no identity at all", () => {
    expect(pick(none)).toMatchObject({ status: 0, out: "-\tad hoc" });
  });

  it("honours an identity asked for by SHA-1, in any case, or by part of its name", () => {
    expect(pick(twoDevelopment, DEV_B.toLowerCase()).out).toBe(`${DEV_B}\tApple Development: Some One (XF9ZCZDXVP)`);
    expect(pick(twoDevelopment, "Some One").out).toBe(`${DEV_B}\tApple Development: Some One (XF9ZCZDXVP)`);
  });

  it("signs ad hoc only when asked to", () => {
    expect(pick(twoDevelopment, "-").out).toBe("-\tad hoc");
  });

  it("fails, rather than signing ad hoc, when the identity asked for does not exist", () => {
    expect(pick(twoDevelopment, "Nobody")).toMatchObject({ status: 1, out: "" });
    expect(pick(none, DEV_A)).toMatchObject({ status: 1, out: "" });
  });
});

describe("timestamps", () => {
  // A secure timestamp needs the network; only a notarizable identity asks.
  it("asks for a secure timestamp only with a Developer ID identity", () => {
    expect(call("codesign_timestamp_flag", ["developer-id"]).out).toBe("--timestamp");
    expect(call("codesign_timestamp_flag", ["development"]).out).toBe("--timestamp=none");
    expect(call("signing_identity_kind", ["Developer ID Application: Example Ltd (TEAM123456)"]).out).toBe(
      "developer-id",
    );
    expect(call("signing_identity_kind", ["Apple Development: Some One (XF9ZCZDXVP)"]).out).toBe("development");
    expect(call("signing_identity_kind", ["-"]).out).toBe("adhoc");
  });
});

describe("the build script", () => {
  it("parses as bash", () => {
    const script = path.resolve(path.dirname(lib), "../build-mac-local.sh");
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });
});
