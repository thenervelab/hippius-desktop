import React, { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { BackButton, CardButton, Icons } from "@/components/ui";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { desktopDir, documentDir, downloadDir } from "@tauri-apps/api/path";
import SectionHeader from "@/components/page-sections/settings/SectionHeader";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";

interface SyncFolderSelectorProps {
  onFolderSelected: (path: string) => void;
  initialPath?: string;
  isFromSettingsPage?: boolean;
  handleBackClick?: () => void;
  isPrivateView?: boolean;
}

const SyncFolderSelector: React.FC<SyncFolderSelectorProps> = ({
  onFolderSelected,
  initialPath,
  isFromSettingsPage = false,
  handleBackClick,
  isPrivateView = true,
}) => {
  const { data: balanceInfo } = useHippiusBalance();
  const {
    data: credits,
  } = useUserCredits();
  const [suggested, setSuggested] = useState({
    desktop: "",
    documents: "",
    downloads: "",
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([desktopDir(), documentDir(), downloadDir()])
      .then(([d, docs, dl]) =>
        setSuggested({ desktop: d, documents: docs, downloads: dl })
      )
      .catch(() => toast.error("Could not retrieve system folder paths"));
  }, []);

  useEffect(() => {
    if (!initialPath) {
      setSelected(null)
      setSelected(null)
      return;
    }
    const key = (Object.keys(suggested) as Array<keyof typeof suggested>).find(
      (k) => suggested[k] === initialPath
    );
    if (key) {
      setSelected(key);
      setCustom(null);
    } else {
      setCustom(initialPath);
      setSelected(initialPath);
    }
  }, [initialPath, suggested]);

  const pickOption = (opt: string) => {
    setSelected((prev) => (prev === opt ? null : opt));
  };

  const pickCustom = async () => {
    try {
      const p = await open({
        directory: true,
        multiple: false,
        title: "Select Folder to Sync",
      });
      if (typeof p === "string") {
        setCustom(p);
        setSelected(p);
      }
    } catch { }
  };

  const apply = async () => {
    console.log("formatCreditBalance(credits)", formatCreditBalance(credits ?? null));
    console.log("balanceInfo", balanceInfo);
    if (!selected) {
      toast.error("Please select a folder to sync");
      return;
    }

    if (!balanceInfo?.data?.free) {
      toast.error(
        "Your balance is zero. Please add funds to your account first."
      );
      return;
    }

    const currentBalance = +formatCreditBalance(balanceInfo.data.free);

    // Check if balance is zero
    if (currentBalance <= 0) {
      toast.error(
        "Your balance is zero. Please add funds to your account first."
      );
      return;
    }

    if (formatCreditBalance(credits ?? null) === "0") {
      toast.error(
        "You have no credits available. Please add credits to your account first."
      );
      return;
    }

    const isStd = ["desktop", "documents", "downloads"].includes(selected);
    const path = isStd
      ? suggested[selected as keyof typeof suggested]
      : custom!;
    setLoading(true);
    try {
      await onFolderSelected(path);
    } catch {
      toast.error("Failed to set sync folder");
    } finally {
      setLoading(false);
    }
  };

  const customName = custom?.split(/[\\/]/).pop() ?? "";

  return (
    <div className="w-full flex flex-col">
      <div
        className={cn(
          "w-full flex-1 relative ",
          !isFromSettingsPage &&
          "bg-[url('/assets/folder-sync-bg-layer.png')] bg-no-repeat bg-cover",
          !initialPath && !isFromSettingsPage && "mt-6"
        )}
      >
        <div className="border relative border-grey-80 overflow-hidden rounded-xl w-full h-full">
          <div className="w-full flex flex-col p-4">
            <div className="w-full flex flex-col gap-4">
              {isFromSettingsPage && (
                <BackButton
                  onBack={() => {
                    if (handleBackClick) return handleBackClick();
                  }}
                />
              )}

              <SectionHeader
                Icon={Icons.File2}
                title={
                  initialPath
                    ? `Change your sync folder`
                    : "Welcome to Hippius!"
                }
                subtitle={
                  initialPath
                    ? `Choose folders to keep your files in sync with Hippius. If you edit or remove files, those changes will be automatically synced.`
                    : `Choose a folder on your device to keep your ${isPrivateView ? "private" : "public"
                    } files in sync with Hippius. If you edit or remove files, those changes will be automatically synced.`
                }
              />
            </div>

            <div className="mt-4 space-y-4">
              {(["desktop", "documents", "downloads"] as const).map((opt) => (
                <div
                  key={opt}
                  className={cn(
                    "flex p-4 border rounded-lg cursor-pointer transition-all duration-200 bg-grey-100",
                    selected === opt
                      ? "border-primary-50 bg-primary-100"
                      : "border-grey-80 hover:border-primary-70 hover:bg-grey-95"
                  )}
                  onClick={() => pickOption(opt)}
                >
                  <div className="flex-shrink-0 mr-4">
                    <div
                      className={cn(
                        "size-4 rounded border flex items-center justify-center",
                        selected === opt
                          ? "bg-primary-50 border-primary-50"
                          : "border-grey-70"
                      )}
                    >
                      {selected === opt && (
                        <Icons.Check className="size-3 text-white" />
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex">
                      <Icons.Folder className="size-4 mr-[6px] text-grey-40" />
                      <span className="font-medium text-base text-grey-40 -mt-0.5">
                        {opt.charAt(0).toUpperCase() + opt.slice(1)}
                      </span>
                      {!initialPath && (
                        <div className="ml-4 px-2 py-1 text-[10px] rounded bg-primary-90 text-primary-50 font-medium border border-grey-80">
                          Suggested folder
                        </div>
                      )}
                    </div>
                    <p className="text-sm text-grey-60 mt-1 ml-6">
                      {suggested[opt]}
                    </p>
                  </div>
                </div>
              ))}
              {custom && (
                <div
                  className={cn(
                    "flex p-4 border rounded-lg cursor-pointer transition-all duration-200 bg-grey-100",
                    selected === custom
                      ? "border-primary-50 bg-primary-100"
                      : "border-grey-80 hover:border-primary-70 hover:bg-grey-95"
                  )}
                  onClick={() => pickOption(custom)}
                >
                  <div className="flex-shrink-0 mr-4">
                    <div
                      className={cn(
                        "size-4 rounded border flex items-center justify-center",
                        selected === custom
                          ? "bg-primary-50 border-primary-50"
                          : "border-grey-70"
                      )}
                    >
                      {selected === custom && (
                        <Icons.Check className="size-3 text-white" />
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex">
                      <Icons.Folder className="size-4 mr-[6px] text-grey-40" />
                      <span className="font-medium text-base text-grey-40 -mt-0.5">
                        {customName}
                      </span>
                    </div>
                    <p className="text-sm text-grey-60 mt-1 ml-6">{custom}</p>
                  </div>
                </div>
              )}
              <button
                onClick={pickCustom}
                className="mt-4 ml-10 flex items-center text-sm font-medium text-primary-50 hover:text-primary-40"
              >
                Choose custom folder
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-end p-5">
        <CardButton
          className="max-w-[160px] h-[48px]"
          variant="dialog"
          disabled={loading || !selected}
          loading={loading}
          onClick={apply}
        >
          <span className="text-lg leading-6 font-medium">
            {loading ? "Setting up..." : "Sync Folder"}
          </span>
        </CardButton>
      </div>
    </div>
  );
};

export default SyncFolderSelector;
