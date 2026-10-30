"use client";

// Screenshot harness (never committed): mounts real components with a
// mocked Tauri bridge so before/after pictures can be taken.
import React, { useEffect, useState } from "react";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { WalletAuthProvider } from "@/app/lib/wallet-auth-context";
import ShareInsightsSheet from "@/components/page-sections/shares/insights/ShareInsightsSheet";
import { insightsSheetAtom, serverCapabilitiesAtom, shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import ShareFileModal from "@/components/page-sections/drive/ShareFileModal";
import NameCell from "@/components/page-sections/drive/files-table/NameCell";
import { DriveRouteContext } from "@/components/page-sections/drive/driveRoute";
import { useSharedFiles } from "@/app/lib/hooks/useSharedFiles";
import CaptureOptionsSetting from "@/components/page-sections/settings/CaptureOptionsSetting";

/** Keeps the share listing loaded, as Shared Links and the Captures rows do in the app. */
function ListingObserver() {
  useSharedFiles();
  return null;
}

const store = createStore();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

declare global {
  interface Window {
    __shots?: Record<string, unknown>;
    __CAPS?: unknown;
    __SCENE?: string;
  }
}

function Bridge() {
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.set(serverCapabilitiesAtom, (window.__CAPS ?? { shares: true, share_insights: true, share_comments: true }) as any);
    window.__shots = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTarget: (t: any) => store.set(insightsSheetAtom, t),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      share: (t: any) => store.set(shareModalFileAtom, t),
      getTarget: () => store.get(insightsSheetAtom),
      invalidate: (key: string) => queryClient.invalidateQueries({ queryKey: [key] }),
    };
    document.body.setAttribute("data-shots-ready", "1");
  }, []);
  return null;
}

function FakePage({ title }: { title: string }) {
  return (
    <main className="min-w-0 flex-1 p-8">
      <h1 className="text-2xl font-semibold text-grey-10 dark:text-white">{title}</h1>
      <div className="mt-6 flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-11 rounded-[10px] bg-grey-90 dark:bg-white/[0.05]" />
        ))}
      </div>
    </main>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Rows() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = ((typeof window !== "undefined" && (window as any).__ROWS) || []) as any[];
  return (
    <DriveRouteContext.Provider value={{ basePath: "/captures", pinned: { label: "Hippius Captures", remote: false } }}>
      <div className="fixed inset-x-8 top-24 z-10 rounded-[12px] border border-grey-80 bg-white p-4 dark:border-[#333] dark:bg-[#1a1a1a]">
        <table className="w-full">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="h-12 border-b border-grey-90 dark:border-[#2a2a2a]">
                <td className="text-xs text-grey-50 w-40 pr-3">{r.where}</td>
                <td className="max-w-[640px]">
                  <NameCell
                    rawName={r.name}
                    arionHash=""
                    isAssigned={false}
                    actualName={r.actualName}
                    label="Hippius Captures"
                    fileType={r.fileType}
                    parentSubFolderPath={r.parent}
                    file={r.file}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DriveRouteContext.Provider>
  );
}

export default function ShotsPage() {
  const [scene, setScene] = useState<string | null>(null);
  useEffect(() => setScene(window.__SCENE ?? "insights"), []);
  if (!scene) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <WalletAuthProvider>
          <Bridge />
          <ListingObserver />
          <div className="flex h-screen w-full bg-white dark:bg-[#141414]">
            <FakePage title="Captures" />
            {scene === "insights" && <ShareInsightsSheet />}
          </div>
          {scene === "share" && <ShareFileModal />}
          {scene === "rows" && <Rows />}
          {scene === "settings" && (
            <div className="fixed left-8 top-24 z-10 w-[560px] rounded-[12px] border border-grey-80 bg-white p-4 dark:border-[#333] dark:bg-[#1a1a1a]" data-testid="settings-scene">
              <CaptureOptionsSetting rowClassName="py-3" recording={false} recordCountdown={false as never} systemAudio={false as never} />
            </div>
          )}
          <Toaster position="top-center" />
        </WalletAuthProvider>
      </Provider>
    </QueryClientProvider>
  );
}
