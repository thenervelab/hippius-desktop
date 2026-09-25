import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";
import ResponsiveContent from "./ResponsiveContent";
import OnBoardingGuard from "./OnBoardingGuard";
import SyncEventLogger from "./SyncEventLogger";
import ConflictEventListener from "./ConflictEventListener";
import SyncFilesHandler from "./SyncFilesHandler";
import MigrationChecker from "./MigrationChecker";
import InsufficientCreditsDialog from "@/components/page-sections/drive/InsufficientCreditsDialog";
import FailedFilesListener from "./FailedFilesListener";
import FinderShareListener from "./FinderShareListener";
import InviteAutoSealListener from "./InviteAutoSealListener";
import FailedFilesModal from "@/components/page-sections/drive/FailedFilesModal";
import ShareFileModal from "@/components/page-sections/drive/ShareFileModal";
import RenameDialog from "@/components/page-sections/drive/RenameDialog";
import NewFolderDialog from "@/components/page-sections/drive/NewFolderDialog";
import AppContextMenu from "@/components/ui/context-menu/AppContextMenu";
import AccountRecoveryDialog from "@/components/recovery/AccountRecoveryDialog";
import RecoveryEventListener from "@/components/recovery/RecoveryEventListener";
import { LocalWalletProvider } from "@/app/contexts/LocalWalletContext";
import ChatHost from "@/components/chat/ChatHost";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <LocalWalletProvider>
        {/* Owns the chat client for the whole signed-in session so
            notifications and the unread badge work off /chat. */}
        <ChatHost>
          <SyncEventLogger />
          <ConflictEventListener />
          <FailedFilesListener />
          <FinderShareListener />
          {/* Delivers emailed invitation keys; does nothing while SHARED_DRIVES_ENABLED is off. */}
          <InviteAutoSealListener />
          <MigrationChecker />
          <InsufficientCreditsDialog />
          <FailedFilesModal />
          <ShareFileModal />
          {/* Renders nothing while SHARED_DRIVES_ENABLED is off. */}
          <RenameDialog />
          <NewFolderDialog />
          {/* Replaces the WebView's Back / Reload / Inspect Element menu.
            Yields to the row and card menus, which handle their own
            right-clicks. */}
          <AppContextMenu />
          <RecoveryEventListener />
          <AccountRecoveryDialog />
          <div className="flex flex-col min-h-screen w-full bg-cover bg-center bg-no-repeat bg-fixed bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]">
            <TopBar />
            <div className="flex flex-1 min-h-0 w-full">
              <SyncFilesHandler />
              <Sidebar />
              <ResponsiveContent>{children}</ResponsiveContent>
            </div>
          </div>
        </ChatHost>
      </LocalWalletProvider>
    </OnBoardingGuard>
  );
}
