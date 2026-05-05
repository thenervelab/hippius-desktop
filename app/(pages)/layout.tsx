import Sidebar from "@/components/sidebar";
import ResponsiveContent from "./ResponsiveContent";
import OnBoardingGuard from "./OnBoardingGuard";
import SyncEventLogger from "./SyncEventLogger";
import ConflictEventListener from "./ConflictEventListener";
import SyncFilesHandler from "./SyncFilesHandler";
import MigrationChecker from "./MigrationChecker";
import InsufficientCreditsDialog from "@/components/page-sections/files/InsufficientCreditsDialog";
import FailedFilesListener from "./FailedFilesListener";
import FailedFilesModal from "@/components/page-sections/files/FailedFilesModal";
import ShareFileModal from "@/components/page-sections/files/ShareFileModal";
import AccountRecoveryDialog from "@/components/recovery/AccountRecoveryDialog";
import RecoveryEventListener from "@/components/recovery/RecoveryEventListener";
import ExistingUserRecoveryPrompt from "@/components/recovery/ExistingUserRecoveryPrompt";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <SyncEventLogger />
      <ConflictEventListener />
      <FailedFilesListener />
      <MigrationChecker />
      <InsufficientCreditsDialog />
      <FailedFilesModal />
      <ShareFileModal />
      <RecoveryEventListener />
      <AccountRecoveryDialog />
      <ExistingUserRecoveryPrompt />
      <div className="flex min-h-screen w-full bg-cover bg-center bg-no-repeat bg-fixed bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]">
        <SyncFilesHandler />
        <Sidebar />
        <ResponsiveContent>{children}</ResponsiveContent>
      </div>
    </OnBoardingGuard>
  );
}
