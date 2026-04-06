/** Map a VM flavor name to its UI category. */
export function getFlavorCategory(flavorName: string): string {
  const name = flavorName.toLowerCase();
  if (name === "spark" || name === "pulse") return "starter";
  if (name === "cipher" || name === "vault") return "standard";
  if (name === "fortress" || name === "titan" || name === "sovereign") return "high-capacity";
  return "all";
}

export type ImageOs = "AlmaLinux" | "CentOS" | "Debian" | "Fedora" | "Rocky Linux" | "Ubuntu";

/** Parse a VM image name into OS type + version for icon display. */
export function parseImageName(imageName: string): { os: ImageOs; version: string } {
  if (imageName.startsWith("AlmaLinux")) return { os: "AlmaLinux", version: imageName };
  if (imageName.startsWith("CentOS")) return { os: "CentOS", version: imageName };
  if (imageName.startsWith("Debian")) return { os: "Debian", version: imageName };
  if (imageName.startsWith("Fedora")) return { os: "Fedora", version: imageName };
  if (imageName.startsWith("Rocky Linux")) return { os: "Rocky Linux", version: imageName };
  if (imageName.startsWith("Ubuntu")) return { os: "Ubuntu", version: imageName };
  return { os: "Ubuntu", version: imageName };
}
