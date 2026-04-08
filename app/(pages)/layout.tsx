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
      <div className="flex min-h-screen w-full">
        <SyncFilesHandler />
        <Sidebar />
        <ResponsiveContent>{children}</ResponsiveContent>
      </div>
    </OnBoardingGuard>
  );
}
