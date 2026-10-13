/**
 * The line every delete confirmation carries about share links.
 *
 * Deleting a file does not end the links made from it yet: the server does
 * not record which file a share was made from, so nothing can find them to
 * turn off. Until it does, the dialog says so and points at Shared Links,
 * where they are turned off by hand.
 */
export function deleteShareLinksNote(items: readonly { isFolder?: boolean }[]): string {
  const folders = items.filter((item) => item.isFolder).length;
  const subject =
    items.length > 1
      ? folders > 0
        ? "Share links made from them or files in them"
        : "Share links made from them"
      : folders > 0
        ? "Share links made from files in it"
        : "Share links made from it";
  return `${subject} keep working. Turn them off in Shared Links.`;
}
