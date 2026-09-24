// Where the Share dialog's "People with access" and the Manage access panel
// read and write: the real Rust commands, or, on a dev or staging build only,
// a preview fixture of fake people and links so both can be looked at with 0
// to 30 rows, slow answers and refusals without a server that has them.
//
// The fixture is switched on per machine from the devtools console:
//
//   localStorage.setItem("hippius:share-dialog-fixture", "12")         // 0..30 people
//   localStorage.setItem("hippius:share-dialog-fixture", "12 locked")  // links locked
//   localStorage.removeItem("hippius:share-dialog-fixture")            // back to real
//
// and read when a Share dialog or the panel opens. It can never run on a beta or
// production build: `SHARE_FIXTURE_AVAILABLE` is false there at build time, so
// the key is ignored. Nothing it does reaches Rust or the server.

import { enabledFrom } from "@/app/lib/buildChannel";
import {
  approveEmailInvite,
  changeDriveMemberRole,
  listAccessPanel,
  listShareAccess,
  removeDriveMember,
  replaceFolderGrants,
  revokeDriveInvite,
  type AccessPanel,
  type AccessPanelHolder,
  type AccessPanelLink,
  type DriveInviteInfo,
  type DriveTarget,
  type ShareAccess,
} from "@/app/lib/tauri/sharedDrives";
import type { DriveRole } from "@/app/lib/shared-drives/roles";

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

/** Dev and staging builds only; false at build time on beta and production. */
export const SHARE_FIXTURE_AVAILABLE =
  enabledFrom("staging") || process.env.NODE_ENV === "development";

export const SHARE_FIXTURE_KEY = "hippius:share-dialog-fixture";
const MAX_FIXTURE_PEOPLE = 30;

/** How many fake people to show, or null when the fixture is off. */
export function shareFixtureSize(
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  read: () => string | null = () => window.localStorage.getItem(SHARE_FIXTURE_KEY),
): number | null {
  if (!available) return null;
  let raw: string | null = null;
  try {
    raw = read();
  } catch {
    return null;
  }
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(MAX_FIXTURE_PEOPLE, n));
}

/** Whether the fixture's links should be drawn locked ("12 locked"). */
export function shareFixtureLocked(
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  read: () => string | null = () => window.localStorage.getItem(SHARE_FIXTURE_KEY),
): boolean {
  if (!available) return false;
  try {
    return (read() ?? "").includes("locked");
  } catch {
    return false;
  }
}

/** The API a dialog or panel opened now should use. */
export function shareAccessApiFor(folder: boolean): ShareAccessApi {
  const size = shareFixtureSize();
  return size === null
    ? realShareAccessApi
    : fixtureShareAccessApi(size, folder, { linksLocked: shareFixtureLocked() });
}

const NAMES = [
  "Sara Khan", "Daniel Ortiz", "Mia Chen", "Lee Park", "Amara Obi", "Jonas Berg",
  "Priya Nair", "Tomás Silva", "Hana Sato", "Omar Haddad", "Elena Rossi", "Kofi Mensah",
];
const SS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fakeSs58(i: number): string {
  let s = "5";
  let x = (i + 7) * 2654435761;
  for (let k = 0; k < 47; k++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += SS58_CHARS[x % SS58_CHARS.length];
  }
  return s;
}

/** A fixture of `size` people: about a third pending invites, some unnamed. */
export function fixtureShareAccess(size: number, folder: boolean): ShareAccess {
  const people = Math.max(0, size);
  const pendingCount = Math.floor(people / 3);
  const memberCount = people - pendingCount;
  const roles: DriveRole[] = ["reader", "writer", "manager"];
  const rows = Array.from({ length: memberCount }, (_, i) => {
    // Every fourth person has no name on file: the row shows a short ss58.
    const named = i % 4 !== 3;
    const name = named ? NAMES[i % NAMES.length] : undefined;
    return {
      memberSs58: fakeSs58(i),
      memberName: name,
      memberEmail: name ? `${name.split(" ")[0].toLowerCase()}@example.com` : undefined,
      role: roles[i % 3],
    };
  });
  const statuses = ["sent", "awaiting_seal", "sealed"] as const;
  const pendingInvites: DriveInviteInfo[] = Array.from({ length: pendingCount }, (_, i) => ({
    inviteId: `fixture-invite-${i}`,
    role: i % 2 ? "writer" : "reader",
    mintedBy: "",
    expiresAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
    maxUses: 1,
    useCount: 0,
    revoked: false,
    valid: true,
    createdAt: new Date().toISOString(),
    recipientEmail: `invitee${i + 1}@example.com`,
    emailStatus: statuses[i % 3],
    ...(folder ? { pathPrefix: "fixture" } : {}),
  }));
  return {
    ownerSs58: fakeSs58(999),
    ownerIsYou: true,
    members: folder ? [] : rows.map((r) => ({ ...r, isYou: false })),
    folderHolders: folder
      ? rows.map((r, i) => ({
          memberSs58: r.memberSs58,
          memberName: r.memberName,
          memberEmail: r.memberEmail,
          role: i % 2 ? "writer" : "reader",
          pathPrefix: "fixture",
          otherFolderCount: i % 3,
        }))
      : [],
    pendingInvites,
    driveMemberCount: folder ? memberCount : rows.length,
  };
}

/** Slow like a real server on a bad day: 400 to 1400 ms. */
function latency(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 1000));
}

/**
 * Every fifth fake row refuses changes, so the inline error is easy to find.
 * Deterministic on the id so the same row always fails.
 */
function refuses(id: string): boolean {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 5 === 0;
}

const REFUSAL = { kind: "Validation", message: "The preview server refused this change (fixture)." };

const DAY_SECS = 86_400;
const FIXTURE_FOLDERS = ["Clients/ACME", "Design", "Finance/2026"];

/** Fake folder holders for a drive panel: about one in four people. */
function fixtureDriveHolders(size: number): AccessPanelHolder[] {
  return Array.from({ length: Math.floor(size / 4) }, (_, i) => {
    const name = i % 3 === 2 ? undefined : NAMES[(i + 5) % NAMES.length];
    const folders = FIXTURE_FOLDERS.slice(0, 1 + (i % 2)).sort();
    return {
      memberSs58: fakeSs58(500 + i),
      memberName: name,
      memberEmail: name ? `${name.split(" ")[0].toLowerCase()}@example.org` : undefined,
      isYou: false,
      role: i % 2 ? "writer" : "reader",
      pathPrefix: folders[0],
      folders,
    };
  });
}

/** On a folder panel: a couple of people who have the whole drive. */
function fixtureWholeDriveMembers(count: number): ShareAccess["members"] {
  return Array.from({ length: Math.min(2, Math.floor(count / 3)) }, (_, i) => ({
    memberSs58: fakeSs58(700 + i),
    memberName: NAMES[(i + 8) % NAMES.length],
    role: i ? "manager" : "writer",
    isYou: false,
  }));
}

/** Fake links: a few working ones of each shape, and some that ended. */
function fixtureLinks(size: number, folder: boolean, locked: boolean): AccessPanelLink[] {
  if (size === 0) return [];
  const url = (i: number) => `https://console.hippius.com/invite/fixture${i}tok3n#k=fixture-key`;
  const base = (i: number, extra: Partial<AccessPanelLink>): AccessPanelLink => ({
    inviteId: `fixture-link-${i}`,
    role: "writer",
    mintedBy: i % 2 ? fakeSs58(3) : fakeSs58(999),
    mintedByName: i % 2 ? NAMES[0] : undefined,
    mintedByYou: i % 2 === 0,
    useCount: 0,
    maxUses: 50,
    singleUse: false,
    usagePercent: 0,
    status: "active",
    expiresAt: new Date(Date.now() + 5 * DAY_SECS * 1000).toISOString(),
    neverExpires: false,
    expiresInSecs: 5 * DAY_SECS,
    inviteUrl: locked ? undefined : url(i),
    linkAvailable: true,
    ...(folder ? { pathPrefix: "fixture" } : {}),
    ...extra,
  });
  const active: AccessPanelLink[] = folder
    ? [base(0, { role: "reader", maxUses: 1, singleUse: true, expiresInSecs: 29 * DAY_SECS })]
    : [
        base(0, { useCount: 12, usagePercent: 24 }),
        base(1, { role: "reader", useCount: 3, usagePercent: 6, neverExpires: true, expiresInSecs: null }),
        base(2, { role: "manager", maxUses: 1, singleUse: true, expiresInSecs: 20 * 3600 }),
      ].slice(0, 1 + Math.floor(size / 6));
  const ended: AccessPanelLink[] = Array.from({ length: Math.floor(size / 8) }, (_, i) =>
    base(10 + i, {
      status: (["revoked", "expired", "used_up"] as const)[i % 3],
      expiresInSecs: null,
      inviteUrl: undefined,
      linkAvailable: false,
    }),
  );
  return [...active, ...ended];
}

/** The panel's listing, built from the same fake people as the dialog. */
export function fixtureAccessPanel(
  access: ShareAccess,
  links: AccessPanelLink[],
  driveHolders: AccessPanelHolder[],
  folder: boolean,
  linksLocked: boolean,
): AccessPanel {
  const now = Date.now();
  const active = links.filter((l) => l.status === "active");
  return {
    ownerSs58: access.ownerSs58,
    ownerIsYou: access.ownerIsYou,
    yourRole: access.ownerIsYou ? "owner" : null,
    canManage: access.ownerIsYou,
    members: (folder ? fixtureWholeDriveMembers(access.driveMemberCount) : access.members).map((m) => ({
      ...m,
      createdAt: "2026-08-20T10:00:00Z",
    })),
    folderHolders: folder
      ? access.folderHolders.map((h) => ({
          memberSs58: h.memberSs58,
          memberName: h.memberName,
          memberEmail: h.memberEmail,
          isYou: false,
          role: h.role,
          pathPrefix: h.pathPrefix,
          folders: [h.pathPrefix, ...FIXTURE_FOLDERS.slice(0, h.otherFolderCount)].sort(),
        }))
      : driveHolders,
    pendingInvites: access.pendingInvites.map((i) => ({
      ...i,
      expiresInSecs: Math.round((Date.parse(i.expiresAt) - now) / 1000),
    })),
    links: active,
    inactiveLinks: links.filter((l) => l.status !== "active"),
    linksLocked: linksLocked && active.some((l) => l.linkAvailable),
    driveMemberCount: access.driveMemberCount,
  };
}

export function fixtureShareAccessApi(
  size: number,
  folder: boolean,
  options: { linksLocked?: boolean } = {},
): ShareAccessApi {
  let state = fixtureShareAccess(size, folder);
  let links = fixtureLinks(size, folder, Boolean(options.linksLocked));
  let driveHolders = fixtureDriveHolders(size);
  const act = async (id: string, change: () => void) => {
    await latency();
    if (refuses(id)) throw REFUSAL;
    change();
  };
  return {
    async list() {
      await latency();
      return structuredClone(state);
    },
    changeRole: (_label, ss58, role) =>
      act(ss58, () => {
        state = { ...state, members: state.members.map((m) => (m.memberSs58 === ss58 ? { ...m, role } : m)) };
      }),
    remove: (_label, ss58) =>
      act(ss58, () => {
        state = {
          ...state,
          members: state.members.filter((m) => m.memberSs58 !== ss58),
          folderHolders: state.folderHolders.filter((h) => h.memberSs58 !== ss58),
        };
        driveHolders = driveHolders.filter((h) => h.memberSs58 !== ss58);
      }),
    revoke: (_label, id) =>
      act(id, () => {
        state = { ...state, pendingInvites: state.pendingInvites.filter((i) => i.inviteId !== id) };
        links = links.map((l) =>
          l.inviteId === id ? { ...l, status: "revoked", inviteUrl: undefined, linkAvailable: false, expiresInSecs: null } : l,
        );
      }),
    approve: (_label, id) =>
      act(id, () => {
        state = {
          ...state,
          pendingInvites: state.pendingInvites.map((i) => (i.inviteId === id ? { ...i, emailStatus: "sealed" } : i)),
        };
      }),
    async listPanel() {
      await latency();
      return structuredClone(fixtureAccessPanel(state, links, driveHolders, folder, Boolean(options.linksLocked)));
    },
    replaceFolders: (_label, ss58, folders) =>
      act(ss58, () => {
        const sorted = [...folders].sort();
        driveHolders = driveHolders.map((h) =>
          h.memberSs58 === ss58 ? { ...h, folders: sorted, pathPrefix: sorted[0] ?? h.pathPrefix } : h,
        );
      }),
  };
}
