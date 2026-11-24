import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Below this size a file always fits one 8 MiB part (its ciphertext is a
 * little larger than the file), so there is no part list to ask for. Kept
 * under 8 MiB on purpose: asking for a file stored whole only costs a
 * request that comes back empty.
 */
export const PART_LIST_MIN_BYTES = 8_000_000;

/** The drive label and path id `get_file_part_hashes` needs, or null. */
export function partHashesTarget(
  file: Pick<FormattedUserFile, "isFolder" | "size" | "arionCid" | "fileId" | "arionHash" | "label" | "remoteDriveLabel">,
): { label: string; pathHash: string } | null {
  if (file.isFolder) return null;
  if (!file.arionCid || file.arionCid === "pending") return null;
  if ((file.size ?? 0) < PART_LIST_MIN_BYTES) return null;
  const label = file.remoteDriveLabel || file.label;
  const pathHash = file.fileId || file.arionHash;
  if (!label || !/^[0-9a-f]{64}$/i.test(pathHash ?? "")) return null;
  return { label, pathHash: pathHash as string };
}

/**
 * Every part hash of a file stored in parts, in order, for File Details.
 *
 * Empty for a file stored whole or as one part, and while the server has
 * not listed the parts. Rust finds the file's server row; the result is
 * kept per file and content hash, so reopening the panel asks again only
 * once the file changes.
 */
export function useFilePartHashes(file: FormattedUserFile) {
  const { polkadotAddress } = useWalletAuth();
  const target = partHashesTarget(file);
  const query = useQuery({
    queryKey: ["file-part-hashes", polkadotAddress, target?.label, target?.pathHash, file.arionCid],
    queryFn: () =>
      invoke<string[]>("get_file_part_hashes", {
        accountId: polkadotAddress,
        label: target?.label,
        pathHash: target?.pathHash,
      }),
    enabled: Boolean(polkadotAddress && target),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return {
    partHashes: query.data ?? [],
    loading: Boolean(target) && query.isLoading,
  };
}
