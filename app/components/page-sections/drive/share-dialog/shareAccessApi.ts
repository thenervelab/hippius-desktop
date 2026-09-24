// Where the Share dialog's "People with access" and the Manage access panel
// read and write: the real Rust commands, or, on a dev or staging build only,
// fake preview data so both can be looked at with 0 to 100 people and links,
// slow answers and refusals, without a server that has them.
//
// The fake data is driven by the Share dev tools panel (`ShareDevTools.tsx`):
//
//   Open it     the "Share dev tools" pill at the bottom left of the app, or
//               Ctrl+Shift+D (Cmd+Shift+D on a Mac). Escape folds it back.
//   Controls    Enable fake data; People 0-100; Pending invites 0-50; Active
//               links 0-100; Expired or revoked links 0-50; Links locked;
//               Loading (hold the skeletons); Error (the load fails); Slow
//               network 0 / 1.2 s / 3 s; Failure rate 0 / 33 / 100 % for
//               role change, remove, cancel, revoke and approve.
//   Presets     Empty, Small team (5), Big drive (60 people, 45 links, 15
//               expired), Huge (100/100/50). Reset goes back to real data.
//
// Changes apply live: an open dialog or panel reloads. The settings live in
// localStorage["hippius:share-devtools"]; the older switch
// localStorage["hippius:share-dialog-fixture"] = "12" (or "12 locked") still
// turns fake data on with that many people.
//
// None of it exists on a beta or production build: `SHARE_FIXTURE_AVAILABLE`
// is false there at build time, `shareAccessApiFor` hands out the real
// commands, and the panel is not mounted. Fake rows never reach Rust or the
// server; every fake answer waits the set latency and may be refused at the
// set rate, so the pessimistic "Saving…" states and inline errors show.

import {
  approveEmailInvite,
  changeDriveMemberRole,
  listAccessPanel,
  listShareAccess,
  removeDriveMember,
  replaceFolderGrants,
  revokeDriveInvite,
  type AccessPanel,
  type DriveTarget,
  type ShareAccess,
} from "@/app/lib/tauri/sharedDrives";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import {
  SHARE_FIXTURE_AVAILABLE,
  activeShareDevSettings,
  subscribeShareDevSettings,
  type ShareDevSettings,
} from "./shareDevToolsSettings";
import {
  buildFixture,
  fixtureAccessPanel,
  fixtureRefuses,
  fixtureShareAccess,
  normalizeFolder,
  type FixtureStore,
} from "./shareFixture";

export { SHARE_FIXTURE_AVAILABLE, SHARE_FIXTURE_KEY } from "./shareDevToolsSettings";

export interface ShareAccessApi {
  list(label: string, pathPrefix: string | null, target?: DriveTarget): Promise<ShareAccess>;
  changeRole(label: string, memberSs58: string, role: DriveRole, target?: DriveTarget): Promise<void>;
  remove(label: string, memberSs58: string, target?: DriveTarget): Promise<void>;
  revoke(label: string, inviteId: string, target?: DriveTarget): Promise<void>;
  approve(label: string, inviteId: string, target?: DriveTarget): Promise<unknown>;
  /** The Manage access panel's listing (`list_access_panel`). */
  listPanel(label: string, pathPrefix: string | null, target?: DriveTarget): Promise<AccessPanel>;
  /** Change folders: `role` applies to folders being added. */
  replaceFolders(
    label: string,
    memberSs58: string,
    folders: string[],
    role: "reader" | "writer" | undefined,
    target?: DriveTarget,
  ): Promise<unknown>;
}

export const realShareAccessApi: ShareAccessApi = {
  list: listShareAccess,
  changeRole: changeDriveMemberRole,
  remove: removeDriveMember,
  revoke: revokeDriveInvite,
  approve: approveEmailInvite,
  listPanel: listAccessPanel,
  replaceFolders: (label, memberSs58, folders, role, target) =>
    replaceFolderGrants(label, memberSs58, folders, { role, target }),
};

/** The API a dialog or panel opened now should use. */
export function shareAccessApiFor(folder: boolean): ShareAccessApi {
  return SHARE_FIXTURE_AVAILABLE ? liveShareAccessApi(folder) : realShareAccessApi;
}

const FIXTURE_LOAD_ERROR = {
  kind: "Network",
  message: "Couldn't load who has access. (Preview error from Share dev tools.)",
};
const FIXTURE_REFUSAL = {
  kind: "Validation",
  message: "The preview server refused this change. (Share dev tools failure rate.)",
};

export interface LiveApiDeps {
  /** The fake-data settings now, or null for the real commands. */
  read: () => ShareDevSettings | null;
  real: ShareAccessApi;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Resolves on the next settings change (to end a Loading hold). */
  nextChange: () => Promise<void>;
}

const defaultDeps: LiveApiDeps = {
  read: () => activeShareDevSettings(),
  real: realShareAccessApi,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nextChange: () =>
    new Promise((resolve) => {
      const stop = subscribeShareDevSettings(() => {
        stop();
        resolve();
      });
    }),
};

/**
 * The real commands while fake data is off, the fixture while it is on,
 * decided on every call so the dev tools apply to a dialog already open.
 * The fake drive is built on first use and rebuilt when a count changes;
 * changes made to it (a role, a removal) last until then.
 */
export function liveShareAccessApi(folder: boolean, deps: Partial<LiveApiDeps> = {}): ShareAccessApi {
  const { read, real, now, sleep, nextChange } = { ...defaultDeps, ...deps };
  let store: FixtureStore | null = null;
  let signature = "";

  const storeFor = (s: ShareDevSettings, pathPrefix: string | null): FixtureStore => {
    const path = folder ? normalizeFolder(pathPrefix ?? "") || "Shared folder" : null;
    const sig = [s.people, s.pending, s.activeLinks, s.endedLinks, s.linksLocked, path].join("|");
    if (!store || sig !== signature) {
      store = buildFixture(s, path, now());
      signature = sig;
    }
    return store;
  };

  /** Wait like a server, and hold while Loading is on. */
  const answer = async (s: ShareDevSettings): Promise<ShareDevSettings> => {
    await sleep(s.latencyMs);
    let current = read() ?? s;
    while (current.loading) {
      await nextChange();
      const next = read();
      // Fake data switched off meanwhile: the surface reloads anyway.
      if (!next) break;
      current = next;
    }
    return current;
  };

  /** A fake change: wait, maybe refuse, then apply it to the fake drive. */
  const act = async (s: ShareDevSettings, id: string, change: (st: FixtureStore) => void) => {
    await sleep(s.latencyMs);
    if (fixtureRefuses(id, s.failureRate)) throw FIXTURE_REFUSAL;
    if (store) change(store);
  };

  return {
    async list(label, pathPrefix, target) {
      const s = read();
      if (!s) return real.list(label, pathPrefix, target);
      const current = await answer(s);
      if (current.error) throw FIXTURE_LOAD_ERROR;
      return structuredClone(fixtureShareAccess(storeFor(current, pathPrefix), folder));
    },
    async listPanel(label, pathPrefix, target) {
      const s = read();
      if (!s) return real.listPanel(label, pathPrefix, target);
      const current = await answer(s);
      if (current.error) throw FIXTURE_LOAD_ERROR;
      return structuredClone(fixtureAccessPanel(storeFor(current, pathPrefix), current.linksLocked, now()));
    },
    changeRole(label, ss58, role, target) {
      const s = read();
      if (!s) return real.changeRole(label, ss58, role, target);
      return act(s, ss58, (st) => {
        st.members = st.members.map((m) => (m.memberSs58 === ss58 ? { ...m, role } : m));
      });
    },
    remove(label, ss58, target) {
      const s = read();
      if (!s) return real.remove(label, ss58, target);
      return act(s, ss58, (st) => {
        st.members = st.members.filter((m) => m.memberSs58 !== ss58);
        st.holders = st.holders.filter((h) => h.memberSs58 !== ss58);
      });
    },
    revoke(label, id, target) {
      const s = read();
      if (!s) return real.revoke(label, id, target);
      return act(s, id, (st) => {
        st.pending = st.pending.filter((i) => i.inviteId !== id);
        st.links = st.links.map((l) =>
          l.inviteId === id
            ? { ...l, status: "revoked", inviteUrl: undefined, linkAvailable: false, expiresInSecs: null }
            : l,
        );
      });
    },
    approve(label, id, target) {
      const s = read();
      if (!s) return real.approve(label, id, target);
      return act(s, id, (st) => {
        st.pending = st.pending.map((i) => (i.inviteId === id ? { ...i, emailStatus: "sealed" } : i));
      });
    },
    replaceFolders(label, ss58, folders, role, target) {
      const s = read();
      if (!s) return real.replaceFolders(label, ss58, folders, role, target);
      return act(s, ss58, (st) => {
        const sorted = [...folders].sort();
        st.holders = st.holders.map((h) =>
          h.memberSs58 === ss58 ? { ...h, folders: sorted, pathPrefix: sorted[0] ?? h.pathPrefix } : h,
        );
      });
    },
  };
}
