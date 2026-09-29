import { driveRoleLabel, type DriveRole } from "./roles";

/**
 * Why a write into this drive will not happen, in words the reader can act on.
 *
 * A drop lands on the page whatever the permission: the file is already on its
 * way before anything can check. Refusing it in SILENCE reads as the app being
 * broken, and refusing it with the server's own error reads as a fault rather
 * than a permission. So the refusal says which role they hold and what to ask
 * for, because asking the owner is the only thing that changes the answer.
 *
 * A frozen drive refuses writes from everyone, including its owner — that
 * check comes first so a frozen Viewer does not get a role-upgrade prompt
 * that cannot help.
 *
 * `null` means the write may proceed: an own drive, or a member drive where
 * the role allows it. Also `null` while the role is unknown — the server
 * refuses anyway, and inventing a reason for a permission nobody has
 * established would be worse than letting the real error speak.
 */
export function driveWriteRefusal(
  role: DriveRole | null | undefined,
  opts?: { frozen?: boolean },
): string | null {
  if (opts?.frozen) {
    return "This drive is frozen, so nobody can upload or change files until the owner resolves the account limit.";
  }
  if (role !== "reader") return null;
  return `You have ${driveRoleLabel("reader")} access to this drive, so you can open and download files but not add them. Ask whoever shared it with you to make you an ${driveRoleLabel("writer")}.`;
}

/**
 * The hover text on a frozen drive's badge. The server sends `frozen_until`
 * as RFC 3339, which is not something to put in front of a person, so it is
 * read as a date; an unparseable or absent value falls back to the plain
 * statement rather than "Invalid Date".
 */
export function frozenNotice(frozenUntil?: string | null): string {
  const until = frozenUntil ? new Date(frozenUntil) : null;
  if (until && !Number.isNaN(until.getTime())) {
    const date = until.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return `Frozen until ${date}. Files can be opened but not changed.`;
  }
  return "This drive is frozen. Files can be opened but not changed.";
}
