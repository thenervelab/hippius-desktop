import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "./decodeHexCid";
import { toast } from "sonner";

export const downloadIpfsFile = async (file: FormattedUserIpfsFile) => {
    const { cid, name, size } = file;

    const toastId = toast.loading(`Starting download: ${name}`);

    try {
        const url = `https://get.hippius.network/ipfs/${decodeHexCid(cid)}?download=1`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(response.statusText);

        const totalBytes = parseInt(response.headers.get('Content-Length') || '0') || size || 0;

        const reader = response.body?.getReader();
        let receivedBytes = 0;
        const chunks: Uint8Array[] = [];

        if (!reader) throw new Error("Unable to read response");

        let lastProgressUpdate = 0;
        const UPDATE_INTERVAL = 500;

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            receivedBytes += value.length;

            const progress = totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : 0;

            const now = Date.now();
            if (now - lastProgressUpdate > UPDATE_INTERVAL) {
                toast.loading(
                    `Downloading: ${name} (${progress}%)`,
                    { id: toastId }
                );
                lastProgressUpdate = now;
            }
        }

        const blob = new Blob(chunks);
        const downloadUrl = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(downloadUrl);

        toast.success(`Download complete: ${name}`, { id: toastId });
    } catch (err) {
        console.error("Download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: toastId });
    }
};

export const streamIpfsFile = async (file: FormattedUserIpfsFile) => {
    const { cid, name } = file;

    const toastId = toast.loading(`Starting download: ${name}`);

    try {
        const url = `https://get.hippius.network/ipfs/${decodeHexCid(cid)}?download=1`;

        if ('showSaveFilePicker' in window) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const fileHandle = await (window as any).showSaveFilePicker({
                    suggestedName: name,
                    types: [{
                        description: 'Files',
                        accept: { '*/*': [] }
                    }]
                });

                const writableStream = await fileHandle.createWritable();

                const response = await fetch(url);
                if (!response.ok) throw new Error(response.statusText);

                const reader = response.body?.getReader();
                const totalBytes = parseInt(response.headers.get('Content-Length') || '0') || 0;
                let receivedBytes = 0;

                if (!reader) throw new Error("Unable to read response");

                let lastProgressUpdate = 0;
                const UPDATE_INTERVAL = 500;

                while (true) {
                    const { done, value } = await reader.read();

                    if (done) break;

                    await writableStream.write(value);
                    receivedBytes += value.length;

                    const progress = totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : 0;

                    const now = Date.now();
                    if (now - lastProgressUpdate > UPDATE_INTERVAL) {
                        toast.loading(
                            `Downloading: ${name} (${progress}%)`,
                            { id: toastId }
                        );
                        lastProgressUpdate = now;
                    }
                }

                await writableStream.close();
                toast.success(`Download complete: ${name}`, { id: toastId });
                return;
            } catch (err) {
                console.warn("File System Access API failed, falling back to regular download:", err);
            }
        }

        return downloadIpfsFile(file);
    } catch (err) {
        console.error("Download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: toastId });
    }
};
