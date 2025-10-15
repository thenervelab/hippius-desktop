import React, { useState, useEffect } from "react";
import { Icons, CardButton, Graphsheet, RevealTextLine } from "@/components/ui";
import { cn } from "@/lib/utils";
import SectionHeader from "./SectionHeader";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { InView } from "react-intersection-observer";

type DeletionBehaviour = "remote-backup" | "mirror-delete" | "restore-files";

interface ConfirmationDialog {
    type: DeletionBehaviour;
    isOpen: boolean;
}

const FileDeletionBehaviour: React.FC = () => {
    const [selectedBehaviour, setSelectedBehaviour] = useState<DeletionBehaviour>("remote-backup");
    const [originalBehaviour, setOriginalBehaviour] = useState<DeletionBehaviour>("remote-backup");
    const [confirmationDialog, setConfirmationDialog] = useState<ConfirmationDialog>({
        type: "remote-backup",
        isOpen: false
    });
    const [isSaving, setIsSaving] = useState(false);

    const hasChanges = selectedBehaviour !== originalBehaviour;

    // Load current setting from backend on component mount
    useEffect(() => {
        const loadCurrentSetting = async () => {
            try {
                // TODO: Implement backend call to get current file deletion behaviour
                // const currentBehaviour = await invoke("get_file_deletion_behaviour");
                // setSelectedBehaviour(currentBehaviour);
                // setOriginalBehaviour(currentBehaviour);

                console.log("Loading current file deletion behaviour setting...");
            } catch (error) {
                console.error("Failed to load file deletion behaviour setting:", error);
            }
        };

        loadCurrentSetting();
    }, []);

    const behaviourOptions = [
        {
            id: "remote-backup" as DeletionBehaviour,
            title: "Remote Backup",
            description: "Keep a copy in the cloud. Your deleted local files will stay safe as backups",
            isDefault: true
        },
        {
            id: "mirror-delete" as DeletionBehaviour,
            title: "Mirror Local Delete",
            description: "Automatically delete the file from the cloud if it's removed from your local computer",
            isDefault: false
        },
        {
            id: "restore-files" as DeletionBehaviour,
            title: "Restore Local Files",
            description: "Automatically re-download deleted files from the cloud to restore them on your computer",
            isDefault: false
        }
    ];

    const getConfirmationContent = (type: DeletionBehaviour) => {
        switch (type) {
            case "remote-backup":
                return {
                    title: "Remote Backup",
                    message: "This will keep files in the cloud as a backup even after being deleted locally. Do you want to proceed?",
                    icon: <Icons.Trash className="size-6 text-white" />
                };
            case "mirror-delete":
                return {
                    title: "Mirror Local Delete",
                    message: "This will delete all files from the cloud that were deleted locally. Do you want to proceed?",
                    icon: <Icons.Trash className="size-6 text-white" />
                };
            case "restore-files":
                return {
                    title: "Restore Local Files",
                    message: "This will download all files from the cloud storage to the local folder. Do you want to proceed?",
                    icon: <Icons.Trash className="size-6 text-white" />
                };
        }
    };

    const handleBehaviourChange = (behaviour: DeletionBehaviour) => {
        setSelectedBehaviour(behaviour);
    };

    const handleSaveChanges = () => {
        setConfirmationDialog({
            type: selectedBehaviour,
            isOpen: true
        });
    };

    const handleConfirmSave = async () => {
        setIsSaving(true);

        try {
            // TODO: Implement backend call to save file deletion behaviour
            // await invoke("set_file_deletion_behaviour", { behaviour: selectedBehaviour });

            // Simulate API call delay
            await new Promise(resolve => setTimeout(resolve, 1000));

            toast.success("File deletion behaviour updated successfully");
            setConfirmationDialog({ type: selectedBehaviour, isOpen: false });

            // Update original behaviour to new saved value
            setOriginalBehaviour(selectedBehaviour);

        } catch (error) {
            console.error("Failed to update file deletion behaviour:", error);
            toast.error("Failed to update file deletion behaviour");
        } finally {
            setIsSaving(false);
        }
    };

    const confirmationContent = getConfirmationContent(confirmationDialog.type);

    return (
        <>
            <InView triggerOnce>
                {({ inView, ref }) => (
                    <div
                        ref={ref}
                        className="flex flex-col w-full relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover border border-grey-80 rounded-lg overflow-hidden">
                        <div className="w-full p-4">
                            <RevealTextLine
                                rotate
                                reveal={inView}
                                parentClassName="w-full"
                                className="delay-300 w-full"
                            >
                                <div className="flex flex-col w-full">
                                    <div className="flex items-start justify-between mb-4">
                                        <SectionHeader
                                            Icon={Icons.Trash}
                                            title="File Deletion Behaviour"
                                            subtitle="Choose what happens when you delete files from syncing folders"
                                            info="Configure how the app handles file deletions to match your workflow preferences and data protection needs."
                                        />
                                        <CardButton
                                            className={cn(
                                                "max-w-[140px] h-10 transition-opacity duration-200",
                                                !hasChanges && "opacity-50 cursor-not-allowed"
                                            )}
                                            variant="primary"
                                            onClick={handleSaveChanges}
                                            disabled={!hasChanges || isSaving}
                                            loading={isSaving}
                                        >
                                            Save Changes
                                        </CardButton>
                                    </div>

                                    <div className="space-y-3">
                                        {behaviourOptions.map((option) => (
                                            <div
                                                key={option.id}
                                                className={cn(
                                                    "flex items-start justify-between p-4 border rounded-lg cursor-pointer transition-colors duration-200 bg-white",
                                                    selectedBehaviour === option.id
                                                        ? "border-primary-70"
                                                        : "bg-grey-100 border-grey-80"
                                                )}
                                                onClick={() => handleBehaviourChange(option.id)}
                                            >
                                                <div className="flex items-start gap-3">
                                                    <div className="mt-1">
                                                        <div
                                                            className={cn(
                                                                "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                                                                selectedBehaviour === option.id
                                                                    ? "bg-primary-90 border-primary-50"
                                                                    : "bg-grey-90 border-grey-70"
                                                            )}
                                                        >
                                                            {selectedBehaviour === option.id && (
                                                                <div className="w-2 h-2 rounded-full bg-primary-50" />
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <h3 className="text-sm font-medium text-grey-10">
                                                                {option.title}
                                                            </h3>
                                                            {option.isDefault && (
                                                                <span className="px-2 py-0.5 text-xs bg-grey-90 border border-grey-80 text-grey-60 rounded">
                                                                    Default
                                                                </span>
                                                            )}
                                                        </div>
                                                        <p className="text-sm text-grey-50 leading-relaxed">
                                                            {option.description}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </RevealTextLine>
                        </div>
                    </div>
                )}
            </InView>

            {/* Confirmation Dialog */}
            <Dialog.Root open={confirmationDialog.isOpen} onOpenChange={(isOpen) => !isOpen && setConfirmationDialog({ ...confirmationDialog, isOpen: false })}>
                <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
                    <Dialog.Title className="sr-only">{confirmationContent.title}</Dialog.Title>

                    {/* Top accent bar (mobile only) */}
                    <div className="h-4 bg-primary-50 md:hidden block" />

                    <div className="px-4">
                        {/* Desktop Header */}
                        <div className="text-2xl font-medium text-grey-10 hidden md:flex flex-col items-center justify-center pb-2 pt-4 gap-4">
                            <div className="size-14 flex justify-center items-center relative">
                                <Graphsheet
                                    majorCell={{
                                        lineColor: [31, 80, 189, 1.0],
                                        lineWidth: 2,
                                        cellDim: 200,
                                    }}
                                    minorCell={{
                                        lineColor: [49, 103, 211, 1.0],
                                        lineWidth: 1,
                                        cellDim: 20,
                                    }}
                                    className="absolute w-full h-full duration-500 opacity-30 z-0"
                                />
                                <div className="bg-white-cloud-gradient-lg absolute w-full h-full z-10" />
                                <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                                    <Icons.Trash className="size-6 text-grey-100" />
                                </div>
                            </div>
                            <span className="text-center text-2xl text-grey-10 font-medium">
                                {confirmationContent.title}
                            </span>
                        </div>

                        {/* Mobile Header */}
                        <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
                            <div className="text-lg font-medium relative mx-auto">
                                <span className="capitalize">{confirmationContent.title}</span>
                            </div>
                            <button onClick={() => setConfirmationDialog({ ...confirmationDialog, isOpen: false })}>
                                <Icons.CloseCircle className="size-6 relative" />
                            </button>
                        </div>

                        {/* Message */}
                        <div className="font-medium text-base text-grey-20 mb-4 text-center">
                            {confirmationContent.message}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex gap-4 mb-6">
                            <CardButton
                                className="text-base w-full"
                                variant="error"
                                onClick={handleConfirmSave}
                                disabled={isSaving}
                                loading={isSaving}
                            >
                                {isSaving ? "Saving..." : "Yes Proceed"}
                            </CardButton>

                            <CardButton
                                className="w-full"
                                variant="secondary"
                                onClick={() => setConfirmationDialog({ ...confirmationDialog, isOpen: false })}
                                disabled={isSaving}
                            >
                                No, Go Back
                            </CardButton>
                        </div>
                    </div>
                </DialogContainer>
            </Dialog.Root>
        </>
    );
};

export default FileDeletionBehaviour;