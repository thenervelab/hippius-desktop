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
 * `null` means the write may proceed: an own drive, or a member drive where
 * the role allows it. Also `null` while the role is unknown — the server
 * refuses anyway, and inventing a reason for a permission nobody has
 * established would be worse than letting the real error speak.
 */
export function driveWriteRefusal(role: DriveRole | null | undefined): string | null {
  if (role !== "reader") return null;
  return `You have ${driveRoleLabel("reader")} access to this drive, so you can open and download files but not add them. Ask whoever shared it with you to make you an ${driveRoleLabel("writer")}.`;
}
