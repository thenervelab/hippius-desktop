import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { resolveArionHash } from "@/lib/utils/resolveArionHash";
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
 * Checks if a file source is an S3 path
 */
export const isS3Source = (source?: string): boolean => {
    return Boolean(source && source.startsWith('s3://'));
};

/**
 * Converts an S3 source path to an HTTPS URL
 * Example: s3://bucket-name/path/to/file.png -> https://s3.hippius.com/bucket-name/path/to/file.png
 */
export const convertS3ToHttpsUrl = (source: string): string => {
    if (!source.startsWith('s3://')) {
        return source;
    }
    const pathWithoutPrefix = source.slice(5); // Remove 's3://'
    return `https://s3.hippius.com/${pathWithoutPrefix}`;
};

/**
 * Checks if an Arion hash is valid (not pending, not empty)
 */
export const isValidArionHash = (hash: string): boolean => {
    const resolved = resolveArionHash(hash);
    return Boolean(resolved && resolved !== "pending" && resolved.trim() !== "");
};

/**
 * Fetches IPFS metadata to check for parts array
 * Returns the CID to use for the actual file content
 */
export const resolveIPFSCid = async (originalHash: string): Promise<string> => {
    const resolved = resolveArionHash(originalHash);
    if (!resolved) return originalHash;

    // Check cache first
    if (ipfsMetadataCache.has(resolved)) {
        const cached = ipfsMetadataCache.get(resolved);
        if (cached?.parts && cached.parts.length > 0) {
            return cached.parts[0].cid;
        }
        return resolved;
    }

    try {
        console.log(`IPFS: Checking metadata for hash ${resolved}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`https://get.hippius.network/ipfs/${resolved}`, {
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
            ipfsMetadataCache.set(resolved, metadata);

            // If parts exist, use the first part's CID
            if (metadata.parts && metadata.parts.length > 0) {
                console.log(`IPFS: Found parts for hash ${resolved}, using part CID: ${metadata.parts[0].cid}`);
                return metadata.parts[0].cid;
            } else {
                console.log(`IPFS: No parts found in metadata for hash ${resolved}`);
            }
        } else {
            console.log(`IPFS: Direct file response for hash ${resolved}`);
            // Cache as null to indicate it's a direct file (not metadata)
            ipfsMetadataCache.set(resolved, null);
        }
    } catch (error) {
        console.error(`Error resolving IPFS hash ${resolved}:`, error);
        // Cache as null to avoid repeated failed requests
        ipfsMetadataCache.set(resolved, null);
    }

    return resolved;
};

/**
 * Determines the appropriate file URL and source type with async hash resolution
 */
export const getFileUrlAndSource = async (file: FormattedUserFile) => {
    const isHashValid = isValidArionHash(file.arionHash);
    const hasLocalSource = isLocalFile(file.source);
    const hasS3Source = isS3Source(file.source);

    // Priority 1: Use local source if available (file is synced locally)
    if (hasLocalSource) {
        const normalised = file.source!.replace(/\\/g, "/");
        return {
            url: convertFileSrc(normalised),
            isFromIpfs: false,
            isFromLocal: true,
            isFromS3: false,
            resolvedCid: null,
        };
    }

    // Priority 2: Use S3 source if available (remote file not synced locally)
    if (hasS3Source) {
        const s3Url = convertS3ToHttpsUrl(file.source!);
        console.log(`URL Resolver: Using S3 URL for ${file.name}: ${s3Url}`);
        return {
            url: s3Url,
            isFromIpfs: false,
            isFromLocal: false,
            isFromS3: true,
            resolvedCid: null,
        };
    }

    // Priority 3: Use IPFS if hash is valid
    if (isHashValid) {
        try {
            console.log(`URL Resolver: Resolving IPFS hash for file ${file.name}`);
            const resolvedCid = await resolveIPFSCid(file.arionHash);
            const finalUrl = `https://get.hippius.network/ipfs/${resolvedCid}`;
            console.log(`URL Resolver: Final IPFS URL for ${file.name}: ${finalUrl}`);
            return {
                url: finalUrl,
                isFromIpfs: true,
                isFromLocal: false,
                isFromS3: false,
                resolvedCid,
            };
        } catch (error) {
            console.error('Failed to resolve IPFS hash, falling back to original:', error);
            const resolvedHash = resolveArionHash(file.arionHash);
            const fallbackUrl = `https://get.hippius.network/ipfs/${resolvedHash}`;
            console.log(`URL Resolver: Fallback IPFS URL for ${file.name}: ${fallbackUrl}`);
            return {
                url: fallbackUrl,
                isFromIpfs: true,
                isFromLocal: false,
                isFromS3: false,
                resolvedCid: resolvedHash,
            };
        }
    }



    // Fallback: Try IPFS even with potentially invalid hash
    const resolvedHash = resolveArionHash(file.arionHash) || file.arionHash;
    return {
        url: `https://get.hippius.network/ipfs/${resolvedHash}`,
        isFromIpfs: true,
        isFromLocal: false,
        isFromS3: false,
        resolvedCid: resolvedHash,
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
 * This will use cached data if available, otherwise falls back to original hash
 */
export const getFileUrlAndSourceSync = (file: FormattedUserFile) => {
    const isHashValid = isValidArionHash(file.arionHash);
    const hasLocalSource = isLocalFile(file.source);
    const hasS3Source = isS3Source(file.source);

    // Priority 1: Use local source if available (file is synced locally)
    if (hasLocalSource) {
        const normalised = file.source!.replace(/\\/g, "/");
        return {
            url: convertFileSrc(normalised),
            isFromIpfs: false,
            isFromLocal: true,
            isFromS3: false,
            resolvedCid: null,
        };
    }

    // Priority 2: Use S3 source if available (remote file not synced locally)
    if (hasS3Source) {
        const s3Url = convertS3ToHttpsUrl(file.source!);
        return {
            url: s3Url,
            isFromIpfs: false,
            isFromLocal: false,
            isFromS3: true,
            resolvedCid: null,
        };
    }

    // Priority 3: Use IPFS if hash is valid
    if (isHashValid) {
        const resolvedHash = resolveArionHash(file.arionHash);

        // Check cache for resolved CID
        const cached = ipfsMetadataCache.get(resolvedHash || '');
        const resolvedCid = (cached?.parts && cached.parts.length > 0)
            ? cached.parts[0].cid
            : resolvedHash;

        return {
            url: `https://get.hippius.network/ipfs/${resolvedCid}`,
            isFromIpfs: true,
            isFromLocal: false,
            isFromS3: false,
            resolvedCid,
        };
    }

    // Fallback: Try IPFS even with potentially invalid hash
    const resolvedHash = resolveArionHash(file.arionHash) || file.arionHash;
    return {
        url: `https://get.hippius.network/ipfs/${resolvedHash}`,
        isFromIpfs: true,
        isFromLocal: false,
        isFromS3: false,
        resolvedCid: resolvedHash,
    };
};