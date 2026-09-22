import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";

const derive = vi.fn(async () => ({ keyBase64: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), keyId: "k", keyName: "Hippius" }));
vi.mock("@/lib/tauri/chat", () => ({ chatDeriveSecretStorageKey: () => derive() }));

const { listOwnDevices, recoveryKeyText } = await import("@/lib/chat/settings");
const { clearSecretStorageKey, setSecretStorageKey } = await import("@/lib/chat/crypto/secret-storage-keys");

describe("recoveryKeyText", () => {
  it("uses the key already in memory and asks Rust only when there is none", async () => {
    clearSecretStorageKey();
    const fromRust = await recoveryKeyText();
    expect(derive).toHaveBeenCalledTimes(1);
    expect(fromRust).toMatch(/^[1-9A-HJ-NP-Za-km-z]{4}( [1-9A-HJ-NP-Za-km-z]{4})+$/);

    setSecretStorageKey(new Uint8Array(32).fill(7), "k");
    const fromMemory = await recoveryKeyText();
    expect(derive).toHaveBeenCalledTimes(1);
    expect(fromMemory).toBe(fromRust);
    clearSecretStorageKey();
  });
});

describe("listOwnDevices", () => {
  it("puts this device first, then most recently seen, and reads verification from crypto", async () => {
    const isVerified = (id: string) => ({ isVerified: () => id === "DEV1" });
    const client = {
      getUserId: () => "@alice:hippius.com",
      getDeviceId: () => "DEV1",
      getCrypto: () => ({ getDeviceVerificationStatus: async (_u: string, id: string) => isVerified(id) }),
      getDevices: async () => ({
        devices: [
          { device_id: "A", display_name: "  ", last_seen_ts: 10 },
          { device_id: "B", display_name: "Phone", last_seen_ts: 30 },
          { device_id: "DEV1", display_name: "Desktop", last_seen_ts: 20 },
        ],
      }),
    } as unknown as MatrixClient;

    const rows = await listOwnDevices(client);
    expect(rows.map((r) => r.deviceId)).toEqual(["DEV1", "B", "A"]);
    expect(rows[0]).toMatchObject({ isCurrent: true, verified: true });
    expect(rows[1]).toMatchObject({ isCurrent: false, verified: false });
    // A blank display name falls back to the id rather than an empty row.
    expect(rows[2].displayName).toBe("A");
  });

  it("reports no verification state when crypto is off", async () => {
    const client = {
      getUserId: () => "@alice:hippius.com",
      getDeviceId: () => "DEV1",
      getCrypto: () => undefined,
      getDevices: async () => ({ devices: [{ device_id: "DEV1" }] }),
    } as unknown as MatrixClient;
    expect((await listOwnDevices(client))[0].verified).toBeNull();
  });
});
