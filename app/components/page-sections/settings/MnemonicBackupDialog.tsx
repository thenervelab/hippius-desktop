"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  OctagonAlert,
  X,
} from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { IconComponent } from "@/app/lib/types";

interface MnemonicBackupDialogProps {
  open: boolean;
  mnemonic: string;
  onConfirm: () => void;
  onClose?: () => void;
}

const MIN_PASSWORD_LENGTH = 8;

const SECURITY_TIPS: { icon: IconComponent; text: string }[] = [
  { icon: Icons.Pencil, text: "Write it on paper — never take a digital photo" },
  { icon: Icons.LockClosed, text: "Store in a fireproof and waterproof safe" },
  { icon: Icons.EyeOutline, text: "Never share it with anyone, including support staff" },
  { icon: Icons.Files, text: "Keep copies in multiple secure locations" },
  { icon: Icons.TriangleAlert, text: "Never store in email, cloud storage, or screenshots" },
];

type Step = 1 | 2;

function StepIndicator({
  current,
  onSelect,
}: {
  current: Step;
  onSelect: (step: Step) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {([1, 2] as const).map((s) => {
        const active = s === current;
        return (
          <button
            key={s}
            type="button"
            aria-label={`Go to step ${s}`}
            aria-current={active ? "step" : undefined}
            onClick={() => onSelect(s)}
            className={cn(
              "h-1 w-8 rounded-full transition-colors",
              active
                ? "bg-[#3167dd]"
                : "bg-grey-80 hover:bg-grey-70 dark:bg-[#3a3a3a] dark:hover:bg-[#4a4a4a]"
            )}
          />
        );
      })}
    </div>
  );
}

export function MnemonicBackupDialog({
  open,
  mnemonic,
  onConfirm,
  onClose,
}: MnemonicBackupDialogProps) {
  const [step, setStep] = useState<Step>(1);
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copied, setCopied] = useState(false);

  // Direction-aware step navigation. Setting direction in the same React
  // render as the step swap means the keyed wrapper below re-mounts with
  // the correct enter animation (slide-in from right for forward,
  // slide-in from left for backward).
  const goToStep = useCallback(
    (next: Step) => {
      if (next === step) return;
      setDirection(next > step ? "forward" : "backward");
      setStep(next);
    },
    [step]
  );

  const [showEncryptForm, setShowEncryptForm] = useState(false);
  const [encryptPassword, setEncryptPassword] = useState("");
  const [encryptConfirm, setEncryptConfirm] = useState("");
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [backupCreated, setBackupCreated] = useState(false);

  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);

  const canClose = !isCreatingBackup;

  const handleClose = useCallback(() => {
    if (!canClose) return;
    if (onClose) {
      onClose();
    } else {
      onConfirm();
    }
  }, [canClose, onClose, onConfirm]);

  useEffect(() => {
    if (open) {
      setStep(1);
      setShowMnemonic(false);
      setCopied(false);
      setShowEncryptForm(false);
      setEncryptPassword("");
      setEncryptConfirm("");
      setIsCreatingBackup(false);
      setBackupCreated(false);
    } else {
      setEncryptPassword("");
      setEncryptConfirm("");
      setShowMnemonic(false);
      if (clipboardTimerRef.current) {
        clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = null;
      }
    }
  }, [open]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Clear clipboard after 30 seconds for security
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = setTimeout(() => {
        navigator.clipboard.writeText("").catch((err: unknown) =>
          console.warn(
            "[MnemonicBackupDialog] Failed to clear clipboard:",
            err
          )
        );
        clipboardTimerRef.current = null;
      }, 30000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const handleEncryptedBackup = async () => {
    if (isCreatingBackup) return;
    setIsCreatingBackup(true);

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const { downloadDir } = await import("@tauri-apps/api/path");

      let saveDir = "";
      try {
        saveDir = await downloadDir();
      } catch {
        // Fall back to filename only
      }
      const fileName = `hippius-recovery-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.zip`;
      const filePath = await save({
        filters: [{ name: "Zip Archive", extensions: ["zip"] }],
        defaultPath: saveDir ? `${saveDir}/${fileName}` : fileName,
      });

      if (!filePath) {
        setIsCreatingBackup(false);
        return;
      }

      await invoke("create_encrypted_backup", {
        mnemonic,
        password: encryptPassword,
        outputPath: filePath,
      });

      setBackupCreated(true);
      setShowEncryptForm(false);
      setEncryptPassword("");
      setEncryptConfirm("");
    } catch (err) {
      console.error("Backup file save failed:", err);
      toast.error("Failed to save encrypted backup. Please try again.");
    } finally {
      setIsCreatingBackup(false);
    }
  };

  const passwordsValid =
    encryptPassword.length >= MIN_PASSWORD_LENGTH &&
    encryptPassword === encryptConfirm;

  if (!mnemonic) return null;

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title={step === 1 ? "Secure Your Mnemonic Seed" : "Your Mnemonic Seed"}
      icon={<Icons.ShieldTick className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
      stepIndicator={<StepIndicator current={step} onSelect={goToStep} />}
    >
      <div
        key={step}
        className={cn(
          direction === "forward"
            ? "animate-tooltip-reveal-right"
            : "animate-tooltip-reveal-left"
        )}
      >
      {step === 1 ? (
        <Step1Warning tips={SECURITY_TIPS} onNext={() => goToStep(2)} />
      ) : (
        <Step2Reveal
          words={words}
          showMnemonic={showMnemonic}
          onToggleShow={() => setShowMnemonic((v) => !v)}
          copied={copied}
          onCopy={handleCopy}
          showEncryptForm={showEncryptForm}
          onToggleEncryptForm={() => setShowEncryptForm((v) => !v)}
          encryptPassword={encryptPassword}
          onEncryptPasswordChange={setEncryptPassword}
          encryptConfirm={encryptConfirm}
          onEncryptConfirmChange={setEncryptConfirm}
          passwordsValid={passwordsValid}
          isCreatingBackup={isCreatingBackup}
          backupCreated={backupCreated}
          onEncryptedBackup={handleEncryptedBackup}
          onConfirm={onConfirm}
        />
      )}
      </div>
    </FramedDialog>
  );
}

function Step1Warning({
  tips,
  onNext,
}: {
  tips: typeof SECURITY_TIPS;
  onNext: () => void;
}) {
  return (
    <>
      <p className="mb-5 text-center text-sm font-medium text-[#4F4F4F] dark:text-grey-dark-300">
        Your mnemonic seed is the only way to restore access to your account
        and encrypted files.
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {tips.map(({ icon: Icon, text }, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-[8px] border border-grey-80 bg-[#fafafa] p-3 dark:border-[#3a3a3a] dark:bg-[#2a2a2a]"
            >
              <Icon className="size-4 flex-shrink-0 text-[#4F4F4F] dark:text-grey-dark-300" />
              <span className="text-sm font-medium text-[#4F4F4F] dark:text-grey-dark-300">
                {text}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <div className="flex items-start gap-2">
            <ArrowRight className="mt-0.5 size-4 flex-shrink-0 text-[#E3E3E3] dark:text-[#3a3a3a]" />
            <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#4F4F4F] dark:text-grey-dark-600">
              Make sure no one is watching your screen before proceeding.
              Anyone with these words gains full access to your account and
              files.
            </p>
          </div>
        </div>

        <Button
          variant="primary"
          size="auto"
          onClick={onNext}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
          )}
        >
          I Understand, Show My Mnemonic Seed
        </Button>
      </div>
    </>
  );
}

interface Step2Props {
  words: string[];
  showMnemonic: boolean;
  onToggleShow: () => void;
  copied: boolean;
  onCopy: () => void;
  showEncryptForm: boolean;
  onToggleEncryptForm: () => void;
  encryptPassword: string;
  onEncryptPasswordChange: (v: string) => void;
  encryptConfirm: string;
  onEncryptConfirmChange: (v: string) => void;
  passwordsValid: boolean;
  isCreatingBackup: boolean;
  backupCreated: boolean;
  onEncryptedBackup: () => void;
  onConfirm: () => void;
}

function Step2Reveal({
  words,
  showMnemonic,
  onToggleShow,
  copied,
  onCopy,
  showEncryptForm,
  onToggleEncryptForm,
  encryptPassword,
  onEncryptPasswordChange,
  encryptConfirm,
  onEncryptConfirmChange,
  passwordsValid,
  isCreatingBackup,
  backupCreated,
  onEncryptedBackup,
  onConfirm,
}: Step2Props) {
  const passwordsMismatch =
    encryptPassword.length > 0 &&
    encryptConfirm.length > 0 &&
    encryptPassword !== encryptConfirm;

  return (
    <>
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Write down each word in order and store it somewhere safe.
      </p>

      <div className="flex flex-col gap-4">
        {/* Word grid */}
        <div className="relative rounded-[8px] border border-grey-80 bg-[#fafafa] p-4 dark:border-[#3a3a3a] dark:bg-[#2a2a2a]">
          <div
            className={cn(
              "grid grid-cols-3 gap-2 transition-all duration-200",
              !showMnemonic && "blur-md select-none"
            )}
          >
            {words.map((word, index) => (
              <div
                key={index}
                className="flex items-center gap-2 rounded-md border border-grey-80 bg-white px-3 py-2 dark:border-[#3a3a3a] dark:bg-[#1a1a1a]"
              >
                <span className="w-5 text-right font-mono text-xs text-grey-40 dark:text-grey-dark-600">
                  {index + 1}.
                </span>
                <span className="text-sm font-medium text-grey-10 dark:text-white">
                  {word}
                </span>
              </div>
            ))}
          </div>

          {!showMnemonic && (
            <button
              type="button"
              onClick={onToggleShow}
              className="absolute inset-0 flex items-center justify-center rounded-[8px] bg-[#fafafa]/60 dark:bg-[#2a2a2a]/60"
            >
              <div className="flex items-center gap-2 rounded-md border border-grey-80 bg-white px-4 py-2 dark:border-[#3a3a3a] dark:bg-[#1a1a1a]">
                <EyeOff className="size-4 text-grey-30 dark:text-grey-dark-300" />
                <span className="text-sm font-medium text-grey-20 dark:text-white">
                  Hidden
                </span>
              </div>
            </button>
          )}
        </div>

        {/* Action row */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={onToggleShow}
            className="h-[36px] rounded-md px-3 text-sm font-medium"
          >
            {showMnemonic ? (
              <>
                <EyeOff className="mr-2 size-4" /> Hide
              </>
            ) : (
              <>
                <Eye className="mr-2 size-4" /> Show
              </>
            )}
          </Button>
          <Button
            variant="defaultStable"
            size="auto"
            onClick={onCopy}
            className="h-[36px] rounded-md px-3 text-sm font-medium"
          >
            {copied ? (
              <>
                <Check className="mr-2 size-4 text-success-50" /> Copied
              </>
            ) : (
              <>
                <Copy className="mr-2 size-4" /> Copy
              </>
            )}
          </Button>
          {!backupCreated && (
            <Button
              variant="defaultStable"
              size="auto"
              onClick={onToggleEncryptForm}
              className="h-[36px] rounded-md px-3 text-sm font-medium"
            >
              {showEncryptForm ? (
                <>
                  <X className="mr-2 size-4" /> Close Download
                </>
              ) : (
                <>
                  <Download className="mr-2 size-4" /> Download Encrypted Backup
                </>
              )}
            </Button>
          )}
          {backupCreated && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-success-50">
              <Check className="size-4" /> Encrypted backup saved
            </div>
          )}
        </div>

        {/* Inline encrypt form — inline (no card wrapper) per Figma */}
        {showEncryptForm && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600">
              Encrypt your recovery phrase with a password and save it as a
              file.
            </p>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Create Password"
              value={encryptPassword}
              onChange={(e) => onEncryptPasswordChange(e.target.value)}
            />
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm Password"
              value={encryptConfirm}
              onChange={(e) => onEncryptConfirmChange(e.target.value)}
            />
            {passwordsMismatch && (
              <p className="text-xs text-error-50">Passwords do not match</p>
            )}
            <Button
              variant="primary"
              size="auto"
              onClick={onEncryptedBackup}
              disabled={!passwordsValid || isCreatingBackup}
              loading={isCreatingBackup}
              className={cn(
                "h-[40px] self-start rounded-[6px] border px-4 text-sm font-medium",
                "border-[#3167DD] bg-[#3167DD] text-white",
                "hover:bg-[#2454c4] hover:border-[#2454c4]",
                "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
              )}
            >
              {isCreatingBackup ? "Encrypting..." : "Encrypt & Save"}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <div className="flex items-start gap-2">
            <ArrowRight className="mt-0.5 size-4 flex-shrink-0 text-[#E3E3E3] dark:text-[#3a3a3a]" />
            <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#4F4F4F] dark:text-grey-dark-600">
              Anyone with these words can take over your account. Hide the
              screen once you&apos;re done.
            </p>
          </div>
        </div>

        <Button
          variant="primary"
          size="auto"
          onClick={onConfirm}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
          )}
        >
          I Have Written It Down
        </Button>
      </div>
    </>
  );
}
