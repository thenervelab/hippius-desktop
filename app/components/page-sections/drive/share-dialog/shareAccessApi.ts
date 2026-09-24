// Where the Share dialog's "People with access" reads and writes: the real
// Rust commands, or, on a dev or staging build only, a preview fixture of
// fake people so the list can be looked at with 0 to 30 rows, slow answers
// and refusals without a server that has them.
//
// The fixture is switched on per machine from the devtools console:
//
//   localStorage.setItem("hippius:share-dialog-fixture", "12")  // 0..30 people
//   localStorage.removeItem("hippius:share-dialog-fixture")     // back to real
//
// and read when a Share dialog opens. It can never run on a beta or
// production build: `SHARE_FIXTURE_AVAILABLE` is false there at build time, so
// the key is ignored. Nothing it does reaches Rust or the server.

import { enabledFrom } from "@/app/lib/buildChannel";
import {
  approveEmailInvite,
  changeDriveMemberRole,
  listShareAccess,
  removeDriveMember,
  revokeDriveInvite,
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
}

export const realShareAccessApi: ShareAccessApi = {
  list: listShareAccess,
  changeRole: changeDriveMemberRole,
  remove: removeDriveMember,
  revoke: revokeDriveInvite,
  approve: approveEmailInvite,
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

/** The API a dialog opened now should use. */
export function shareAccessApiFor(folder: boolean): ShareAccessApi {
  const size = shareFixtureSize();
  return size === null ? realShareAccessApi : fixtureShareAccessApi(size, folder);
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

export function fixtureShareAccessApi(size: number, folder: boolean): ShareAccessApi {
  let state = fixtureShareAccess(size, folder);
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
      }),
    revoke: (_label, id) =>
      act(id, () => {
        state = { ...state, pendingInvites: state.pendingInvites.filter((i) => i.inviteId !== id) };
      }),
    approve: (_label, id) =>
      act(id, () => {
        state = {
          ...state,
          pendingInvites: state.pendingInvites.map((i) => (i.inviteId === id ? { ...i, emailStatus: "sealed" } : i)),
        };
      }),
  };
}
