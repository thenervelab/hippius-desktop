import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { convertFileSrc } from "@tauri-apps/api/core";

// Type for IPFS metadata response with parts
interface IPFSMetadataResponse {
    object_id: string;
    object_key: string;
    appendable: boolean;
    content_type: string;
    parts?: Array<{
        part_number: number;
        cid: string;
        size_bytes: number;
    }>;
}

// Cache for IPFS metadata responses to avoid repeated API calls
const ipfsMetadataCache = new Map<string, IPFSMetadataResponse | null>();

/**
 * Checks if a file source indicates it's a local file
 */
export const isLocalFile = (source?: string): boolean => {
    return Boolean(
        source &&
        !source.startsWith('s3://') &&
        (source.includes('/') || source.includes('\\'))
    );
};

/**
 * Checks if a CID is valid (not pending, not empty)
 */
export const isValidCid = (cid: string): boolean => {
    const decodedCid = decodeHexCid(cid);
    return Boolean(decodedCid && decodedCid !== "pending" && decodedCid.trim() !== "");
};

/**
 * Fetches IPFS metadata to check for parts array
 * Returns the CID to use for the actual file content
 */
export const resolveIPFSCid = async (originalCid: string): Promise<string> => {
    const decodedCid = decodeHexCid(originalCid);
    if (!decodedCid) return originalCid;

    // Check cache first
    if (ipfsMetadataCache.has(decodedCid)) {
        const cached = ipfsMetadataCache.get(decodedCid);
        if (cached?.parts && cached.parts.length > 0) {
            return cached.parts[0].cid;
        }
        return decodedCid;
    }

    try {
        console.log(`IPFS: Checking metadata for CID ${decodedCid}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        const response = await fetch(`https://get.hippius.network/ipfs/${decodedCid}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        console.log(`IPFS: Response status ${response.status}, content-type: ${response.headers.get('content-type')}`);

        // If the response is JSON, it might contain parts
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const metadata: IPFSMetadataResponse = await response.json();
            console.log(`IPFS: Received metadata:`, metadata);

            // Cache the metadata
            ipfsMetadataCache.set(decodedCid, metadata);

            // If parts exist, use the first part's CID
            if (metadata.parts && metadata.parts.length > 0) {
                console.log(`IPFS: Found parts for CID ${decodedCid}, using part CID: ${metadata.parts[0].cid}`);
                return metadata.parts[0].cid;
            } else {
                console.log(`IPFS: No parts found in metadata for CID ${decodedCid}`);
            }
        } else {
            console.log(`IPFS: Direct file response for CID ${decodedCid}`);
            // Cache as null to indicate it's a direct file (not metadata)
            ipfsMetadataCache.set(decodedCid, null);
        }
    } catch (error) {
        console.error(`Error resolving IPFS CID ${decodedCid}:`, error);
        // Cache as null to avoid repeated failed requests
        ipfsMetadataCache.set(decodedCid, null);
    }

    return decodedCid;
};

/**
 * Determines the appropriate file URL and source type with async CID resolution
 */
export const getFileUrlAndSource = async (file: FormattedUserFile) => {
    const isCidValid = isValidCid(file.cid);
    const hasLocalSource = isLocalFile(file.source);

    // Priority 2: Use local source if available
    if (hasLocalSource) {
        const normalised = file.source!.replace(/\\/g, "/");
        return {
            url: convertFileSrc(normalised),
            isFromIpfs: false,
            isFromLocal: true,
            resolvedCid: null,
        };
    }

    // Priority 1: Use IPFS if CID is valid
    if (isCidValid) {
        try {
            console.log(`URL Resolver: Resolving IPFS CID for file ${file.name}`);
            const resolvedCid = await resolveIPFSCid(file.cid);
            const finalUrl = `https://get.hippius.network/ipfs/${resolvedCid}`;
            console.log(`URL Resolver: Final IPFS URL for ${file.name}: ${finalUrl}`);
            return {
                url: finalUrl,
                isFromIpfs: true,
                isFromLocal: false,
                resolvedCid,
            };
        } catch (error) {
            console.error('Failed to resolve IPFS CID, falling back to original:', error);
            const decodedCid = decodeHexCid(file.cid);
            const fallbackUrl = `https://get.hippius.network/ipfs/${decodedCid}`;
            console.log(`URL Resolver: Fallback IPFS URL for ${file.name}: ${fallbackUrl}`);
            return {
                url: fallbackUrl,
                isFromIpfs: true,
                isFromLocal: false,
                resolvedCid: decodedCid,
            };
        }
    }



    // Fallback: Try IPFS even with potentially invalid CID
    const decodedCid = decodeHexCid(file.cid) || file.cid;
    return {
        url: `https://get.hippius.network/ipfs/${decodedCid}`,
        isFromIpfs: true,
        isFromLocal: false,
        resolvedCid: decodedCid,
    };
};

/**
 * Testing function to manually check URL resolution
 * Call this in browser console: window.testIpfsUrl(cid)
 */
export const testIpfsUrlResolution = async (cid: string) => {
    try {
        console.log('Testing IPFS URL resolution for CID:', cid);
        const resolvedCid = await resolveIPFSCid(cid);
        const finalUrl = `https://get.hippius.network/ipfs/${resolvedCid}`;
        console.log('Resolved CID:', resolvedCid);
        console.log('Final URL:', finalUrl);
        return finalUrl;
    } catch (error) {
        console.error('URL resolution test failed:', error);
        return null;
    }
};

/**
 * Test video playability by trying to load it
 */
export const testVideoPlayability = async (url: string) => {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.onloadeddata = () => {
            console.log('Video test - Can load:', url);
            resolve(true);
        };
        video.onerror = (error) => {
            console.error('Video test - Cannot load:', url, error);
            resolve(false);
        };
        video.src = url;
    });
};

// Make test functions available globally for debugging
if (typeof window !== 'undefined') {
    const windowWithTests = window as typeof window & {
        testIpfsUrl: typeof testIpfsUrlResolution;
        testVideo: typeof testVideoPlayability;
        clearIpfsCache: () => void;
    };
    windowWithTests.testIpfsUrl = testIpfsUrlResolution;
    windowWithTests.testVideo = testVideoPlayability;
    windowWithTests.clearIpfsCache = () => {
        ipfsMetadataCache.clear();
        console.log('IPFS metadata cache cleared');
    };
}

/**
 * Synchronous version for cases where we can't use async
 * This will use cached data if available, otherwise falls back to original CID
 */
export const getFileUrlAndSourceSync = (file: FormattedUserFile) => {
    const isCidValid = isValidCid(file.cid);
    const hasLocalSource = isLocalFile(file.source);

    // Priority 1: Use IPFS if CID is valid
    if (isCidValid) {
        const decodedCid = decodeHexCid(file.cid);

        // Check cache for resolved CID
        const cached = ipfsMetadataCache.get(decodedCid || '');
        const resolvedCid = (cached?.parts && cached.parts.length > 0)
            ? cached.parts[0].cid
            : decodedCid;

        return {
            url: `https://get.hippius.network/ipfs/${resolvedCid}`,
            isFromIpfs: true,
            isFromLocal: false,
            resolvedCid,
        };
    }

    // Priority 2: Use local source if available
    if (hasLocalSource) {
        const normalised = file.source!.replace(/\\/g, "/");
        return {
            url: convertFileSrc(normalised),
            isFromIpfs: false,
            isFromLocal: true,
            resolvedCid: null,
        };
    }

    // Fallback: Try IPFS even with potentially invalid CID
    const decodedCid = decodeHexCid(file.cid) || file.cid;
    return {
        url: `https://get.hippius.network/ipfs/${decodedCid}`,
        isFromIpfs: true,
        isFromLocal: false,
        resolvedCid: decodedCid,
    };
};