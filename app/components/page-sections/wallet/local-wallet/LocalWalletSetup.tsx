"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { Icons } from "@/components/ui";

import WelcomeScreen from "./WelcomeScreen";
import CreateMnemonicScreen from "./CreateMnemonicScreen";
import ImportWalletScreen from "./ImportWalletScreen";
import CreatePasswordScreen from "./CreatePasswordScreen";

// Step ordering used to infer slide direction. Steps at the same depth
// (create-mnemonic ↔ import-wallet) crossfade in place instead of
// sliding sideways past each other.
const STEP_ORDER: Record<string, number> = {
  loading: 0,
  welcome: 0,
  "create-mnemonic": 1,
  "import-wallet": 1,
  "create-password": 2,
  "enter-password": 2,
  ready: 3,
};

const slideVariants = {
  enter: (dir: number) => ({
    x: dir > 0 ? 32 : dir < 0 ? -32 : 0,
    opacity: 0,
  }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({
    x: dir > 0 ? -32 : dir < 0 ? 32 : 0,
    opacity: 0,
  }),
};

const slideTransition: Transition = {
  x: { type: "tween", duration: 0.24, ease: [0.4, 0, 0.2, 1] },
  opacity: { duration: 0.18 },
};

const LocalWalletSetup: React.FC = () => {
  const { setupStep, setSetupStep, isLoading, refreshWallets } =
    useLocalWallet();

  // Owned here (not in context) so the mnemonic and the name picked on
  // the create-mnemonic step are scoped to this orchestrator and get
  // dropped on unmount.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  // Tracks how the user reached the create-password step so that screen
  // can render the right variant ("create" badge + headline vs the
  // "access" asterisk hero + "Enter Your Password" wording).
  const [passwordFlow, setPasswordFlow] = useState<"create" | "access">(
    "create",
  );

  // Direction tracking for slide animations: +1 = forward, -1 = back, 0
  // = sibling step (same depth). Updated AFTER the render so the
  // current paint can still read the "from" depth.
  const prevStepRef = useRef(setupStep);
  const fromDepth = STEP_ORDER[prevStepRef.current] ?? 0;
  const toDepth = STEP_ORDER[setupStep] ?? 0;
  const direction = toDepth - fromDepth;

  useEffect(() => {
    prevStepRef.current = setupStep;
  }, [setupStep]);

  useEffect(() => {
    return () => {
      setPendingMnemonic(null);
      setPendingName(null);
    };
  }, []);

  const renderStep = () => {
    if (isLoading || setupStep === "loading") {
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <Icons.HippiusLogoLoader className="size-16 animate-pulse text-primary-50 dark:text-primary-brand-dark" />
          <p className="mt-4 text-grey-50 dark:text-grey-dark-600">
            Loading wallet…
          </p>
        </div>
      );
    }

    switch (setupStep) {
      case "welcome":
        return (
          <WelcomeScreen
            onCreateNew={() => setSetupStep("create-mnemonic")}
            onImport={() => setSetupStep("import-wallet")}
            onAccessKeyContinue={(mnemonic) => {
              setPendingMnemonic(mnemonic);
              setPasswordFlow("access");
              setSetupStep("create-password");
            }}
          />
        );
      case "create-mnemonic":
        return (
          <CreateMnemonicScreen
            onContinue={(mnemonic, name) => {
              setPendingMnemonic(mnemonic);
              setPendingName(name);
              setPasswordFlow("create");
              setSetupStep("create-password");
            }}
            onBack={() => setSetupStep("welcome")}
          />
        );
      case "import-wallet":
        return (
          <ImportWalletScreen
            onImported={() => {
              // Import is a single-screen flow — file + password are
              // submitted from inside ImportWalletScreen, no separate
              // create-password step. After the wallet lands in the
              // local store, refresh and route back to welcome; the
              // wallet selector will switch to the new entry on its
              // own once refreshWallets settles.
              void refreshWallets();
              setSetupStep("welcome");
            }}
            onBack={() => setSetupStep("welcome")}
          />
        );
      case "create-password":
        if (!pendingMnemonic) {
          // Stale step landing without a mnemonic in flight — restart.
          setSetupStep("welcome");
          return null;
        }
        return (
          <CreatePasswordScreen
            mnemonic={pendingMnemonic}
            initialName={pendingName ?? undefined}
            variant={passwordFlow}
            onCreated={() => {
              setPendingMnemonic(null);
              setPendingName(null);
              setPasswordFlow("create");
              void refreshWallets();
            }}
            onBack={() => setSetupStep("welcome")}
          />
        );
      case "enter-password":
        // Reserved for the unlock-after-restart flow; not wired yet.
        setSetupStep("welcome");
        return null;
      case "ready":
        return null;
      default:
        return (
          <WelcomeScreen
            onCreateNew={() => setSetupStep("create-mnemonic")}
            onImport={() => setSetupStep("import-wallet")}
            onAccessKeyContinue={(mnemonic) => {
              setPendingMnemonic(mnemonic);
              setPasswordFlow("access");
              setSetupStep("create-password");
            }}
          />
        );
    }
  };

  return (
    <AnimatePresence custom={direction} mode="wait" initial={false}>
      <motion.div
        key={setupStep}
        custom={direction}
        variants={slideVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={slideTransition}
        className="flex flex-1 w-full"
      >
        {renderStep()}
      </motion.div>
    </AnimatePresence>
  );
};

export default LocalWalletSetup;
