import Sidebar from "@/components/sidebar";
import ResponsiveContent from "./ResponsiveContent";
import OnBoardingGuard from "./OnBoardingGuard";
import UpdateChecker from "@/components/updater/UpdateChecker";
import UnpinnedFilesHandler from "./UnpinnedFilesHandler";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <div className="flex min-h-screen w-full">
        <UpdateChecker />
        <UnpinnedFilesHandler />
        <Sidebar />
        <ResponsiveContent>{children}</ResponsiveContent>
      </div>
    </OnBoardingGuard>
  );
}
