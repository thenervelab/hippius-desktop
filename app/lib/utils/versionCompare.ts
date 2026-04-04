/** Check if v1 >= v2 using semver-style comparison. */
export function isVersionGreaterOrEqual(v1: string, v2: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parse(v1), parse(v2)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const n1 = a[i] ?? 0;
    const n2 = b[i] ?? 0;
    if (n1 > n2) return true;
    if (n1 < n2) return false;
  }
  return true;
}
