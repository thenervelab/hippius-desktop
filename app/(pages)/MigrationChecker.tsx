"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { migrationCheckAtom } from "@/lib/global-atoms/migrationAtoms";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import {
  useMigration,
  MigrationPromptDialog,
  MigrationConfirmSkipDialog,
  MigrationCompleteDialog,
} from "@/components/page-sections/files/migration";
import { HcfsSetupDialog } from "@/components/page-sections/settings/HcfsSetupDialog";

/**
 * Global migration checker that renders at the layout level.
 * Reacts to migrationCheckAtom (set during login) and shows
 * migration dialogs regardless of which page the user is on.
 *
 * This is the single place that calls check_migration — the login
 * flow only sets shouldCheck=true on the atom to trigger this.
 */
const MigrationChecker: React.FC = () => {
  const migrationCheck = useAtomValue(migrationCheckAtom);
  const { polkadotAddress } = useWalletAuth();
  const migration = useMigration();

  useEffect(() => {
    if (
      migrationCheck.shouldCheck &&
      !migration.currentStep &&
      polkadotAddress
    ) {
      migration.checkMigration(polkadotAddress);
    }
  }, [migrationCheck.shouldCheck, polkadotAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!migration.currentStep) return null;

  return (
    <>
      {migration.currentStep === "prompt" && (
        <MigrationPromptDialog
          open
          onMigrate={(syncPath: string) =>
            polkadotAddress &&
            migration.startMigration(polkadotAddress, syncPath)
          }
          onSkip={() => migration.setCurrentStep("skip-confirm")}
          fileCount={migration.fileCount}
          totalSize={migration.totalSize}
        />
      )}
      {migration.currentStep === "skip-confirm" && (
        <MigrationConfirmSkipDialog
          open
          onClose={() => migration.setCurrentStep("prompt")}
          onConfirm={migration.confirmSkip}
          fileCount={migration.fileCount}
        />
      )}
      {migration.currentStep === "setup" && (
        <HcfsSetupDialog
          open
          onClose={() => migration.setCurrentStep("prompt")}
          onComplete={migration.onSetupComplete}
          loading={migration.isSettingUp}
        />
      )}
      {migration.currentStep === "complete" && (
        <MigrationCompleteDialog
          open
          onClose={migration.closeMigration}
          successCount={migration.successCount}
          failedCount={migration.failedCount}
          totalCount={migration.fileCount}
          failedFiles={migration.failedFiles}
          transitionError={migration.transitionError}
          onDismiss={migration.dismissAfterError}
          migrationSucceeded={migration.migrationSucceeded}
          isTransitioning={migration.isTransitioning}
        />
      )}
    </>
  );
};

export default MigrationChecker;
