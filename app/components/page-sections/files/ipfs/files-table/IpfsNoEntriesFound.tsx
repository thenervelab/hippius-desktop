import { CardButton, Graphsheet } from "@/components/ui";
import { HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import React, { useState, useCallback, DragEvent, ChangeEvent, useRef } from "react";
import { toast } from "sonner";

// Custom event for communicating with AddButton
const HIPPIUS_DROP_EVENT = 'hippius:file-drop';
const HIPPIUS_OPEN_MODAL_EVENT = 'hippius:open-modal';

const IPFSNoEntriesFound: React.FC = () => {
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFiles = useCallback((files: FileList) => {
        if (files.length === 0) {
            toast.error("No Files Found");
            return;
        }
        if (typeof window !== 'undefined') {
            const event = new CustomEvent(HIPPIUS_DROP_EVENT, { detail: { files } });
            window.dispatchEvent(event);
            toast.success(
                `${files.length} ${files.length === 1 ? 'file' : 'files'} ready to upload`
            );
        }
    }, []);

    const handleOpenModal = useCallback((e?: React.MouseEvent) => {
        e?.preventDefault();
        e?.stopPropagation();
        if (typeof window !== 'undefined') {
            const event = new CustomEvent(HIPPIUS_OPEN_MODAL_EVENT, {
                bubbles: true,
                detail: { source: 'no-entries-button' },
            });
            window.dispatchEvent(event);
        }
    }, []);

    const handleOnChange = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files) handleFiles(files);
        e.target.value = '';
    };

    const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files);
        }
    }, [handleFiles]);

    const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    return (
        <div
            className={cn(
                "w-full h-[80vh] p-6 flex flex-col items-center justify-center transition-all duration-200",
                isDragging && "bg-gray-50 border-2 border-dashed border-primary-50"
            )}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            <div className="text-2xl font-medium text-grey-10 flex flex-col items-center justify-center pt-4 gap-4">
                <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                    <Graphsheet
                        majorCell={{ lineColor: [221, 227, 245, 1], lineWidth: 1, cellDim: 40 }}
                        minorCell={{ lineColor: [31, 80, 189, 0], lineWidth: 1, cellDim: 40 }}
                        className="absolute w-full h-full top-0 left-0 duration-300 opacity-10 hidden sm:block"
                    />
                    <div className="bg-large-white-cloud-gradient absolute inset-0" />
                    <div className="flex items-center justify-center h-8 w-8 bg-primary-50 rounded-[8px] relative">
                        <HippiusLogo className="size-9 text-white" />
                    </div>
                </div>
                <span>No Entries in Your Storage</span>
            </div>

            <div className="flex flex-col items-center justify-center mt-4 max-w-[320px]">
                <div className="text-sm text-grey-60 font-medium mb-4 text-center">
                    {!isDragging ? (
                        <>You currently do not have any entries uploaded to Hippius. <span className="text-primary-50">Drop files here or use the button</span></>
                    ) : (
                        <div className="mt-2 text-primary-50 font-bold">Drop files here to upload</div>
                    )}
                </div>

                <CardButton onClick={handleOpenModal} className="flex gap-x-2 items-center w-full h-14">
                    Upload a File
                </CardButton>
            </div>

            <input
                multiple
                type="file"
                ref={fileInputRef}
                onChange={handleOnChange}
                className="hidden"
            />
        </div>
    );
};

export default IPFSNoEntriesFound;
