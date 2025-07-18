import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

interface SyncFolderSelectorProps {
    onFolderSelected: (path: string) => void;
}

const SyncFolderSelector: React.FC<SyncFolderSelectorProps> = ({ onFolderSelected }) => {
    const [selectedOption, setSelectedOption] = useState<string | null>(null);
    const [customFolder, setCustomFolder] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Get suggested folder paths from system
    const [suggestedFolders, setSuggestedFolders] = useState({
        desktop: "/User/username/Desktop",
        documents: "/User/username/Documents",
        downloads: "/User/username/Downloads"
    });

    // Fetch actual user folder paths when component mounts
    React.useEffect(() => {
        const getSystemPaths = async () => {
            try {
                const paths = await invoke<{
                    desktop: string;
                    documents: string;
                    downloads: string;
                }>("get_system_folders");

                setSuggestedFolders(paths);
            } catch (error) {
                console.error("Failed to get system folders:", error);
            }
        };

        getSystemPaths();
    }, []);

    const handleOptionSelect = (option: string) => {
        setSelectedOption(option);
        setCustomFolder(null);
    };

    const handleAddFolder = async () => {
        try {
            // Open a folder picker dialog
            const selectedPath = await open({
                directory: true,
                multiple: false,
                title: "Select Folder to Sync"
            });

            if (selectedPath && typeof selectedPath === "string") {
                setCustomFolder(selectedPath);
                setSelectedOption(null);
            }
        } catch (error) {
            console.error("Failed to select folder:", error);
        }
    };

    const handleSyncFolder = async () => {
        // Get the selected folder path
        const folderPath = customFolder || (selectedOption ? suggestedFolders[selectedOption as keyof typeof suggestedFolders] : null);

        if (!folderPath) {
            toast.error("Please select a folder to sync");
            return;
        }

        setIsSubmitting(true);
        try {
            // Here we would normally call the backend to set the sync folder
            // For now we just wait a bit and then call the onFolderSelected callback
            await new Promise(resolve => setTimeout(resolve, 500));

            // Call the parent component's callback with the selected path
            onFolderSelected(folderPath);
            toast.success(`Folder "${folderPath}" selected for syncing`);
        } catch (error) {
            console.error("Failed to set sync folder:", error);
            toast.error("Failed to set sync folder");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="max-w-screen-md mx-auto bg-white rounded-lg p-6 shadow-sm border border-grey-80">
            <div className="flex items-center mb-6">
                <Icons.FolderOpen className="size-10 text-primary-50 mr-3" />
                <div>
                    <h2 className="text-xl font-medium text-grey-10">Welcome to hippius!</h2>
                    <p className="text-grey-50">Choose local folders to sync. Changes will auto-sync to your cloud workspace in real time.</p>
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-grey-30 mb-3">Choose folders to sync from your computer to here:</h3>

                <div className="space-y-4">
                    {/* Desktop Option */}
                    <div
                        className={cn(
                            "flex items-center p-4 border rounded-lg cursor-pointer",
                            selectedOption === "desktop"
                                ? "border-primary-50 bg-primary-100"
                                : "border-grey-80 hover:border-primary-70"
                        )}
                        onClick={() => handleOptionSelect("desktop")}
                    >
                        <div className="flex-shrink-0 mr-3">
                            <input
                                type="checkbox"
                                checked={selectedOption === "desktop"}
                                onChange={() => { }}
                                className="h-5 w-5 accent-primary-50"
                            />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center">
                                <Icons.Folder className="size-5 mr-2 text-primary-50" />
                                <span className="font-medium text-grey-10">Desktop</span>
                            </div>
                            <p className="text-sm text-grey-70 mt-1">{suggestedFolders.desktop}</p>
                        </div>
                    </div>

                    {/* Documents Option */}
                    <div
                        className={cn(
                            "flex items-center p-4 border rounded-lg cursor-pointer",
                            selectedOption === "documents"
                                ? "border-primary-50 bg-primary-100"
                                : "border-grey-80 hover:border-primary-70"
                        )}
                        onClick={() => handleOptionSelect("documents")}
                    >
                        <div className="flex-shrink-0 mr-3">
                            <input
                                type="checkbox"
                                checked={selectedOption === "documents"}
                                onChange={() => { }}
                                className="h-5 w-5 accent-primary-50"
                            />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center">
                                <Icons.Document className="size-5 mr-2 text-primary-50" />
                                <span className="font-medium text-grey-10">Document</span>
                            </div>
                            <p className="text-sm text-grey-70 mt-1">{suggestedFolders.documents}</p>
                        </div>
                    </div>

                    {/* Download Option */}
                    <div
                        className={cn(
                            "flex items-center p-4 border rounded-lg cursor-pointer",
                            selectedOption === "downloads"
                                ? "border-primary-50 bg-primary-100"
                                : "border-grey-80 hover:border-primary-70"
                        )}
                        onClick={() => handleOptionSelect("downloads")}
                    >
                        <div className="flex-shrink-0 mr-3">
                            <input
                                type="checkbox"
                                checked={selectedOption === "downloads"}
                                onChange={() => { }}
                                className="h-5 w-5 accent-primary-50"
                            />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center">
                                <Icons.DocumentDownload className="size-5 mr-2 text-primary-50" />
                                <span className="font-medium text-grey-10">Download</span>
                            </div>
                            <p className="text-sm text-grey-70 mt-1">{suggestedFolders.downloads}</p>
                        </div>
                    </div>

                    {/* Custom folder (if selected) */}
                    {customFolder && (
                        <div className="flex items-center p-4 border border-primary-50 bg-primary-100 rounded-lg">
                            <div className="flex-shrink-0 mr-3">
                                <input
                                    type="checkbox"
                                    checked={true}
                                    onChange={() => { }}
                                    className="h-5 w-5 accent-primary-50"
                                />
                            </div>
                            <div className="flex-1">
                                <div className="flex items-center">
                                    <Icons.FolderOpen className="size-5 mr-2 text-primary-50" />
                                    <span className="font-medium text-grey-10">Custom folder</span>
                                </div>
                                <p className="text-sm text-grey-70 mt-1">{customFolder}</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Add folder button */}
                <button
                    onClick={handleAddFolder}
                    className="mt-4 text-primary-50 hover:text-primary-70 flex items-center text-sm font-medium"
                >
                    <Icons.AddCircle className="size-4 mr-1" />
                    Add folder
                </button>
            </div>

            <div className="flex justify-end">
                <button
                    onClick={handleSyncFolder}
                    disabled={isSubmitting || (!selectedOption && !customFolder)}
                    className={cn(
                        "px-6 py-2.5 font-medium rounded-md text-white flex items-center",
                        (!selectedOption && !customFolder) || isSubmitting
                            ? "bg-grey-80 cursor-not-allowed"
                            : "bg-primary-50 hover:bg-primary-70"
                    )}
                >
                    {isSubmitting ? (
                        <>
                            <Icons.Loader className="size-4 mr-2 animate-spin" />
                            Setting up...
                        </>
                    ) : (
                        <>
                            Sync Folder
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default SyncFolderSelector;
