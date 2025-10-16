import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";

export const shouldAllowPreview = (
    file: FormattedUserIpfsFile,
    hasCheckmark: boolean,
    isPrivateFolder: boolean
): boolean => {
    if (!isPrivateFolder) return true;
    return hasCheckmark;
};