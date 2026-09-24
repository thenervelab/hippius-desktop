// Fake people, invitations and links for the Share dialog and the Manage
// access panel, drawn when the Share dev tools switch fake data on (dev and
// staging builds only; see `shareAccessApi.ts` and `ShareDevTools.tsx`).
//
// Presentation data only: it stands in for what `list_share_access` and
// `list_access_panel` send, so the UI can be looked at with 0 to 100 people
// and links. It decides nothing a real listing would decide differently, and
// it never reaches Rust or the server.
//
// Deterministic: the same counts, folder and clock give the same rows, so a
// screenshot can be taken twice and a test can pin the shapes.

import type {
  AccessPanel,
  AccessPanelHolder,
  AccessPanelLink,
  AccessPanelMember,
  DriveInviteInfo,
  ShareAccess,
} from "@/app/lib/tauri/sharedDrives";
import type { ShareDevSettings } from "./shareDevToolsSettings";

export type FixtureCounts = Pick<ShareDevSettings, "people" | "pending" | "activeLinks" | "endedLinks" | "linksLocked">;

/** Everything the fake server knows about one drive or folder. */
export interface FixtureStore {
  ownerSs58: string;
  /** Whole-drive members (on a folder: the few who have the whole drive). */
  members: AccessPanelMember[];
  /** Folder holders: tagged with their folders on a drive, of this folder on a folder. */
  holders: AccessPanelHolder[];
  pending: DriveInviteInfo[];
  /** Working and ended links together; the panel splits them by status. */
  links: AccessPanelLink[];
}

const HOUR = 3600;
const DAY = 24 * HOUR;

const NAMES = [
  "Sara Khan", "Daniel Ortiz", "Mia Chen", "Lee Park", "Amara Obi", "Jonas Berg",
  "Priya Nair", "Tomás Silva", "Hana Sato", "Omar Haddad", "Elena Rossi", "Kofi Mensah",
  "Lucas Moreau", "Ingrid Holm", "Ravi Patel", "Zoe Adams", "Yusuf Demir", "Chloé Martin",
];
/** Names long enough to test truncation in a 360px panel. */
const LONG_NAMES = [
  "Maximiliana Alexandrovna Konstantinopoulou-Richardson",
  "Bartholomew Fitzgerald Wolfeschlegelsteinhausen",
  "Anastasia Valentina Papadopoulou-Montgomery",
];
const FOLDERS = [
  "Clients/ACME",
  "Design",
  "Finance/2026",
  "Marketing/Campaigns/Autumn launch",
  "Clients/ACME Corporation International/2026 Quarterly Reports/Final versions",
  "Photos",
  "Legal/Contracts",
];
const SS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A well-spread 32-bit hash of an integer (deterministic "random"). */
export function mix(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function hashString(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return mix(h);
}

export function fakeSs58(i: number): string {
  let s = "5";
  let x = mix(i + 7);
  for (let k = 0; k < 47; k++) {
    x = mix(x + k);
    s += SS58_CHARS[x % SS58_CHARS.length];
  }
  return s;
}

function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/** A person's name (or none, about one in five) and email. */
function person(i: number): { name?: string; email?: string } {
  if (i % 5 === 4) return {};
  const long = i % 9 === 7;
  const name = long ? LONG_NAMES[i % LONG_NAMES.length] : NAMES[mix(i) % NAMES.length];
  const domain = i % 11 === 3 ? "research-and-development.very-long-company-domain.example.com" : "example.com";
  return { name, email: `${slug(name)}${i}@${domain}` };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** "Clients/ACME" from " /Clients/ACME/ ". */
export function normalizeFolder(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/**
 * Build the fake drive (`folder` null) or folder. People are split into
 * whole-drive members and a few folder holders; on a folder almost everyone
 * holds the folder and a couple have the whole drive.
 */
export function buildFixture(counts: FixtureCounts, folder: string | null, now: number): FixtureStore {
  const people = Math.max(0, counts.people);
  const wholeDrive = folder !== null ? Math.min(2, Math.floor(people / 10)) : 0;
  const holderCount = folder !== null ? people - wholeDrive : Math.floor(people / 10);
  const memberCount = folder !== null ? wholeDrive : people - holderCount;
  const ownerSs58 = fakeSs58(999);

  const members: AccessPanelMember[] = Array.from({ length: memberCount }, (_, i) => {
    const { name, email } = person(i);
    return {
      memberSs58: fakeSs58(i),
      memberName: name,
      memberEmail: email,
      role: mix(i * 31 + 1) % 2 ? "writer" : "reader",
      isYou: false,
      createdAt: iso(now - (i + 1) * 3 * DAY * 1000),
    };
  });

  const holders: AccessPanelHolder[] = Array.from({ length: holderCount }, (_, j) => {
    const { name, email } = person(500 + j);
    const others = FOLDERS.filter((_, k) => (k + j) % FOLDERS.length < j % 3);
    let tag: string;
    if (folder === null) {
      tag = FOLDERS[j % FOLDERS.length];
    } else {
      // About one in four holds a folder around this one ("Through ...").
      tag = (j % 4 === 3 && parentOf(folder)) || folder;
    }
    const folders = [tag, ...others.filter((f) => f !== tag)].sort();
    return {
      memberSs58: fakeSs58(500 + j),
      memberName: name,
      memberEmail: email,
      isYou: false,
      role: mix(j * 17 + 3) % 2 ? "writer" : "reader",
      pathPrefix: tag,
      folders,
    };
  });

  const statuses = ["sent", "awaiting_seal", "sealed"] as const;
  const pending: DriveInviteInfo[] = Array.from({ length: Math.max(0, counts.pending) }, (_, k) => ({
    inviteId: `fixture-invite-${k}`,
    role: k % 2 ? "writer" : "reader",
    mintedBy: ownerSs58,
    expiresAt: iso(now + ((k % 7) + 1) * DAY * 1000 - (k % 5) * HOUR * 1000),
    maxUses: 1,
    useCount: 0,
    revoked: false,
    valid: true,
    createdAt: iso(now - (k + 1) * HOUR * 1000),
    recipientEmail:
      k % 6 === 5
        ? `invitee.with.a.rather.long.address.${k + 1}@research-and-development.example.com`
        : `invitee${k + 1}@example.com`,
    emailStatus: statuses[k % 3],
    ...(folder !== null ? { pathPrefix: folder } : {}),
  }));

  const links = [
    ...Array.from({ length: Math.max(0, counts.activeLinks) }, (_, a) =>
      activeLink(a, ownerSs58, folder, counts.linksLocked, now),
    ),
    ...Array.from({ length: Math.max(0, counts.endedLinks) }, (_, e) => endedLink(e, ownerSs58, folder, now)),
  ];

  return { ownerSs58, members, holders, pending, links };
}

const MAX_USES = [5, 10, 25, 50, 100];
/** Fractions of uses taken, from none to one short of full. */
const USAGE = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
/** Seconds left on an expiring link: some soon, some far off. */
const EXPIRES_IN = [20 * HOUR, 45 * 60, 3 * DAY, 6 * DAY, 29 * DAY];

/** Who made a link: you, a named member, an unnamed one, or unknown. */
function creator(i: number, ownerSs58: string): Pick<AccessPanelLink, "mintedBy" | "mintedByName" | "mintedByYou"> {
  switch (i % 4) {
    case 0:
      return { mintedBy: ownerSs58, mintedByYou: true };
    case 1:
      return { mintedBy: fakeSs58(i), mintedByName: NAMES[i % NAMES.length], mintedByYou: false };
    case 2:
      return { mintedBy: fakeSs58(800 + i), mintedByYou: false };
    default:
      return { mintedBy: "", mintedByYou: false };
  }
}

function activeLink(a: number, ownerSs58: string, folder: string | null, locked: boolean, now: number): AccessPanelLink {
  const singleUse = a % 4 === 3;
  const maxUses = singleUse ? 1 : MAX_USES[mix(a * 13 + 5) % MAX_USES.length];
  // A working link always has a use left: a full one is "used up".
  const useCount = singleUse ? 0 : Math.min(maxUses - 1, Math.round(maxUses * USAGE[a % USAGE.length]));
  const neverExpires = a % 5 === 1;
  const expiresInSecs = neverExpires ? null : EXPIRES_IN[a % EXPIRES_IN.length];
  return {
    inviteId: `fixture-link-${a}`,
    role: mix(a * 7 + 2) % 3 === 0 ? "writer" : "reader",
    ...creator(a, ownerSs58),
    useCount,
    maxUses,
    singleUse,
    usagePercent: Math.round((useCount / maxUses) * 100),
    status: "active",
    expiresAt: neverExpires ? iso(now + 100 * 365 * DAY * 1000) : iso(now + (expiresInSecs ?? 0) * 1000),
    neverExpires,
    expiresInSecs,
    inviteUrl: locked ? undefined : `https://console.hippius.com/invite/fx${a}q7rTnB4vW8yHc#k=fixture-key`,
    linkAvailable: true,
    ...(folder !== null ? { pathPrefix: folder } : {}),
  };
}

function endedLink(e: number, ownerSs58: string, folder: string | null, now: number): AccessPanelLink {
  const status = (["revoked", "expired", "used_up"] as const)[e % 3];
  const maxUses = MAX_USES[e % MAX_USES.length];
  const useCount = status === "used_up" ? maxUses : Math.floor(maxUses / (2 + (e % 3)));
  return {
    inviteId: `fixture-ended-${e}`,
    role: e % 2 ? "writer" : "reader",
    ...creator(e + 1, ownerSs58),
    useCount,
    maxUses,
    singleUse: false,
    usagePercent: Math.round((useCount / maxUses) * 100),
    status,
    expiresAt: iso(now - (e + 1) * DAY * 1000),
    neverExpires: false,
    expiresInSecs: null,
    linkAvailable: false,
    ...(folder !== null ? { pathPrefix: folder } : {}),
  };
}

/** What the Share dialog's `list_share_access` would send. */
export function fixtureShareAccess(store: FixtureStore, folder: boolean): ShareAccess {
  return {
    ownerSs58: store.ownerSs58,
    ownerIsYou: true,
    members: folder ? [] : store.members.map(({ createdAt: _createdAt, ...m }) => m),
    folderHolders: folder
      ? store.holders.map((h) => ({
          memberSs58: h.memberSs58,
          memberName: h.memberName,
          memberEmail: h.memberEmail,
          role: h.role,
          pathPrefix: h.pathPrefix,
          otherFolderCount: Math.max(0, h.folders.length - 1),
        }))
      : [],
    pendingInvites: store.pending,
    driveMemberCount: store.members.length,
  };
}

/** What the panel's `list_access_panel` would send. */
export function fixtureAccessPanel(store: FixtureStore, linksLocked: boolean, now: number): AccessPanel {
  const active = store.links.filter((l) => l.status === "active");
  return {
    ownerSs58: store.ownerSs58,
    ownerIsYou: true,
    yourRole: "owner",
    canManage: true,
    members: store.members,
    folderHolders: store.holders,
    pendingInvites: store.pending.map((i) => ({
      ...i,
      expiresInSecs: Math.round((Date.parse(i.expiresAt) - now) / 1000),
    })),
    links: active,
    inactiveLinks: store.links.filter((l) => l.status !== "active"),
    linksLocked: linksLocked && active.some((l) => l.linkAvailable),
    driveMemberCount: store.members.length,
  };
}

/**
 * Whether the fake server refuses a change to `id` at this failure rate.
 * Decided by the id, so at 33% the same rows always refuse and are easy to
 * find again.
 */
export function fixtureRefuses(id: string, failureRate: number): boolean {
  if (failureRate <= 0) return false;
  if (failureRate >= 100) return true;
  return hashString(id) % 100 < failureRate;
}
