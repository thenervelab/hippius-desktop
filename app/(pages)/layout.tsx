import Sidebar from "@/components/sidebar";
import ResponsiveContent from "./ResponsiveContent";
import OnBoardingGuard from "./OnBoardingGuard";
import SyncEventLogger from "./SyncEventLogger";
import SyncSetupPrompt from "./SyncSetupPrompt";
import ConflictEventListener from "./ConflictEventListener";
// TODO: Re-enable once backend integration is stable and syncing is reliable
// import UnpinnedFilesHandler from "./UnpinnedFilesHandler";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <SyncEventLogger />
      <SyncSetupPrompt />
      <ConflictEventListener />
      <div className="flex min-h-screen w-full">
        {/* TODO: Re-enable Pinning Queue once backend integration is stable */}
        {/* <UnpinnedFilesHandler /> */}
        <Sidebar />
        <ResponsiveContent>{children}</ResponsiveContent>
      </div>
    </OnBoardingGuard>
  );
}
