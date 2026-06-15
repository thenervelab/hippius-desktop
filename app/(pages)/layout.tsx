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
import FailedFilesModal from "@/components/page-sections/drive/FailedFilesModal";
import ShareFileModal from "@/components/page-sections/drive/ShareFileModal";
import RenameDialog from "@/components/page-sections/drive/RenameDialog";
import AccountRecoveryDialog from "@/components/recovery/AccountRecoveryDialog";
import RecoveryEventListener from "@/components/recovery/RecoveryEventListener";
import { LocalWalletProvider } from "@/app/contexts/LocalWalletContext";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <LocalWalletProvider>
        <SyncEventLogger />
        <ConflictEventListener />
        <FailedFilesListener />
        <MigrationChecker />
        <InsufficientCreditsDialog />
        <FailedFilesModal />
        <ShareFileModal />
        <RenameDialog />
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
      </LocalWalletProvider>
    </OnBoardingGuard>
  );
}
