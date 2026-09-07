/**
 * One stored exclude line, as returned by `list_exclude_patterns`.
 *
 * `pattern` is the line as written in the drive's exclude file and is the key
 * a `remove_exclude_pattern` call must send back. `display` is what to show:
 * Rust unescapes a literal file exclusion back to the file name, and returns
 * a user-typed glob as typed.
 */
export interface ExcludePatternEntry {
  pattern: string;
  display: string;
}
