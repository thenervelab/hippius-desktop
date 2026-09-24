// The dev-only preview data behind the Share dev tools: the real commands
// whenever fake data is off (always, on beta and production), the counts the
// panel asks for, deterministic rows shaped like a real listing, and fake
// answers that wait and refuse as set.

import { describe, it, expect, vi } from "vitest";
import {
  liveShareAccessApi,
  realShareAccessApi,
  shareAccessApiFor,
  type ShareAccessApi,
} from "../shareAccessApi";
import {
  buildFixture,
  fakeSs58,
  fixtureAccessPanel,
  fixtureRefuses,
  fixtureShareAccess,
} from "../shareFixture";
import { DEFAULT_SETTINGS, PRESETS, applyPreset, type ShareDevSettings } from "../shareDevToolsSettings";
import { peopleCount } from "../../access-panel/accessPanelView";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const on = (over: Partial<ShareDevSettings> = {}): ShareDevSettings => ({ ...DEFAULT_SETTINGS, enabled: true, ...over });

function fakeReal(): ShareAccessApi {
  const fail = () => Promise.reject(new Error("real command called"));
  return {
    list: vi.fn(fail),
    changeRole: vi.fn(fail),
    remove: vi.fn(fail),
    revoke: vi.fn(fail),
    approve: vi.fn(fail),
    listPanel: vi.fn(fail),
    replaceFolders: vi.fn(fail),
  };
}

/** A live API over settings the test controls, answering at once. */
function harness(settings: ShareDevSettings | null, folder = false) {
  const state = { settings };
  const listeners: Array<() => void> = [];
  const real = fakeReal();
  const api = liveShareAccessApi(folder, {
    read: () => state.settings,
    real,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    nextChange: () => new Promise<void>((resolve) => listeners.push(resolve)),
  });
  const change = (next: ShareDevSettings | null) => {
    state.settings = next;
    listeners.splice(0).forEach((l) => l());
  };
  return { api, real, change };
}

describe("which API a surface gets", () => {
  it("is the real commands on this build, which stands in for production", () => {
    expect(shareAccessApiFor(false)).toBe(realShareAccessApi);
    expect(shareAccessApiFor(true)).toBe(realShareAccessApi);
  });

  it("goes to the real commands while fake data is off", async () => {
    const { api, real } = harness(null);
    await expect(api.list("x", null)).rejects.toThrow("real command called");
    await expect(api.changeRole("x", "5abc", "reader")).rejects.toThrow("real command called");
    expect(real.list).toHaveBeenCalledOnce();
    expect(real.changeRole).toHaveBeenCalledOnce();
  });

  it("never calls a real command while fake data is on", async () => {
    const { api, real } = harness(on({ people: 10, pending: 3, activeLinks: 3 }));
    const access = await api.list("x", null);
    const panel = await api.listPanel("x", null);
    await api.changeRole("x", access.members[0].memberSs58, "writer");
    await api.revoke("x", panel.links[0].inviteId);
    await api.approve("x", access.pendingInvites[1].inviteId);
    await api.remove("x", access.members[1].memberSs58);
    for (const fn of Object.values(real)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the presets' counts", () => {
  for (const preset of PRESETS) {
    it(`${preset.label}: a drive panel shows what it names`, () => {
      const s = applyPreset(DEFAULT_SETTINGS, preset.id);
      const panel = fixtureAccessPanel(buildFixture(s, null, NOW), false, NOW);
      // The owner is listed on top of the people asked for.
      expect(peopleCount(panel)).toBe(1 + preset.counts.people);
      expect(panel.pendingInvites).toHaveLength(preset.counts.pending);
      expect(panel.links).toHaveLength(preset.counts.activeLinks);
      expect(panel.inactiveLinks).toHaveLength(preset.counts.endedLinks);
    });

    it(`${preset.label}: a folder panel shows what it names`, () => {
      const s = applyPreset(DEFAULT_SETTINGS, preset.id);
      const panel = fixtureAccessPanel(buildFixture(s, "Clients/ACME", NOW), false, NOW);
      expect(peopleCount(panel)).toBe(1 + preset.counts.people);
      expect(panel.links).toHaveLength(preset.counts.activeLinks);
    });
  }

  it("keeps the dialog's people to the drive's members and invitations", () => {
    const store = buildFixture(applyPreset(DEFAULT_SETTINGS, "big"), null, NOW);
    const access = fixtureShareAccess(store, false);
    expect(access.members.length + store.holders.length).toBe(60);
    expect(access.folderHolders).toHaveLength(0);
    expect(access.pendingInvites).toHaveLength(6);
  });
});

describe("generation", () => {
  it("is deterministic", () => {
    const s = applyPreset(DEFAULT_SETTINGS, "huge");
    expect(buildFixture(s, null, NOW)).toEqual(buildFixture(s, null, NOW));
    expect(buildFixture(s, "Design", NOW)).toEqual(buildFixture(s, "Design", NOW));
  });

  it("gives every account a distinct address", () => {
    const all = Array.from({ length: 1000 }, (_, i) => fakeSs58(i));
    expect(new Set(all).size).toBe(1000);
    expect(all.every((a) => a.length === 48 && a.startsWith("5"))).toBe(true);
  });

  it("draws people like a real drive: mixed roles, some unnamed, some long", () => {
    const store = buildFixture(applyPreset(DEFAULT_SETTINGS, "huge"), null, NOW);
    const roles = new Set(store.members.map((m) => m.role));
    expect(roles).toEqual(new Set(["reader", "writer"]));
    const unnamed = store.members.filter((m) => !m.memberName).length;
    expect(unnamed / store.members.length).toBeGreaterThan(0.15);
    expect(unnamed / store.members.length).toBeLessThan(0.25);
    expect(store.members.some((m) => (m.memberName ?? "").length > 40)).toBe(true);
    expect(store.members.some((m) => (m.memberEmail ?? "").length > 60)).toBe(true);
    expect(store.holders.length).toBeGreaterThan(0);
    expect(store.holders.every((h) => h.folders.includes(h.pathPrefix))).toBe(true);
    expect(JSON.stringify(store)).not.toMatch(/manager/i);
  });

  it("draws every invitation stage", () => {
    const store = buildFixture(on({ pending: 9 }), null, NOW);
    expect(new Set(store.pending.map((p) => p.emailStatus))).toEqual(new Set(["sent", "awaiting_seal", "sealed"]));
  });

  it("draws links of every shape, none of them full while active", () => {
    const panel = fixtureAccessPanel(buildFixture(on({ activeLinks: 40, endedLinks: 12 }), null, NOW), false, NOW);
    const links = panel.links;
    expect(links.some((l) => l.singleUse)).toBe(true);
    expect(links.some((l) => !l.singleUse && l.useCount === 0)).toBe(true);
    expect(links.some((l) => l.usagePercent >= 90)).toBe(true);
    expect(links.every((l) => l.useCount < l.maxUses)).toBe(true);
    expect(links.some((l) => l.neverExpires && l.expiresInSecs === null)).toBe(true);
    expect(links.some((l) => (l.expiresInSecs ?? Infinity) < 86_400)).toBe(true);
    expect(new Set(links.map((l) => l.role))).toEqual(new Set(["reader", "writer"]));
    expect(links.some((l) => l.mintedByYou)).toBe(true);
    expect(links.some((l) => l.mintedByName)).toBe(true);
    expect(links.some((l) => !l.mintedBy)).toBe(true);
    expect(links.every((l) => l.inviteUrl)).toBe(true);
    expect(new Set(panel.inactiveLinks.map((l) => l.status))).toEqual(new Set(["revoked", "expired", "used_up"]));
    expect(panel.linksLocked).toBe(false);
  });

  it("can draw the links locked", () => {
    const panel = fixtureAccessPanel(buildFixture(on({ activeLinks: 5, linksLocked: true }), null, NOW), true, NOW);
    expect(panel.linksLocked).toBe(true);
    expect(panel.links.some((l) => l.inviteUrl)).toBe(false);
  });

  it("has nobody but the owner when empty", () => {
    const panel = fixtureAccessPanel(buildFixture(applyPreset(DEFAULT_SETTINGS, "empty"), "Work", NOW), false, NOW);
    expect(panel.members).toHaveLength(0);
    expect(panel.folderHolders).toHaveLength(0);
    expect(panel.links).toHaveLength(0);
  });
});

describe("the failure rate", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `row-${i}`);

  it("refuses nothing at 0% and everything at 100%", () => {
    expect(ids.some((id) => fixtureRefuses(id, 0))).toBe(false);
    expect(ids.every((id) => fixtureRefuses(id, 100))).toBe(true);
  });

  it("refuses about a third at 33%, the same rows every time", () => {
    const refused = ids.filter((id) => fixtureRefuses(id, 33));
    expect(refused.length / ids.length).toBeGreaterThan(0.25);
    expect(refused.length / ids.length).toBeLessThan(0.42);
    expect(ids.filter((id) => fixtureRefuses(id, 33))).toEqual(refused);
  });

  it("refuses a change and leaves the row as it was", async () => {
    const { api } = harness(on({ people: 5, failureRate: 100 }));
    const before = await api.list("x", null);
    const m = before.members[0];
    await expect(api.changeRole("x", m.memberSs58, m.role === "reader" ? "writer" : "reader")).rejects.toMatchObject({
      kind: "Validation",
    });
    expect((await api.list("x", null)).members[0]).toEqual(m);
  });

  it("applies a change when nothing is refused", async () => {
    const { api } = harness(on({ people: 5 }));
    const m = (await api.list("x", null)).members[0];
    const next = m.role === "reader" ? "writer" : "reader";
    await api.changeRole("x", m.memberSs58, next);
    expect((await api.list("x", null)).members[0].role).toBe(next);
  });
});

describe("the latency, loading and error switches", () => {
  it("waits the set latency before answering", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const api = liveShareAccessApi(false, { read: () => on({ latencyMs: 3000 }), sleep, now: () => NOW });
    await api.list("x", null);
    await api.remove("x", "nobody");
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("holds a listing while Loading is on", async () => {
    const { api, change } = harness(on({ loading: true, people: 3 }));
    let landed = false;
    const listed = api.listPanel("x", null).then((p) => {
      landed = true;
      return p;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(landed).toBe(false);
    change(on({ loading: false, people: 3 }));
    expect(peopleCount(await listed)).toBe(4);
  });

  it("fails a listing while Error is on", async () => {
    const { api } = harness(on({ error: true }));
    await expect(api.list("x", null)).rejects.toMatchObject({ kind: "Network" });
    await expect(api.listPanel("x", null)).rejects.toMatchObject({ kind: "Network" });
  });

  it("rebuilds the fake drive when a count changes", async () => {
    const { api, change } = harness(on({ people: 3 }));
    expect((await api.list("x", null)).members).toHaveLength(3);
    change(on({ people: 40 }));
    expect(peopleCount(await api.listPanel("x", null))).toBe(41);
  });
});
