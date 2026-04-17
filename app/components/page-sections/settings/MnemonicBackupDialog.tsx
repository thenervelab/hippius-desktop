"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "../../ui/DialogContainer";
import { Button } from "../../ui/button";
import ProgressBar from "../../auth/onboarding/ProgressBar";
import { toast } from "sonner";
import { Graphsheet } from "@/components/ui";
import {
  Eye,
  EyeOff,
  Copy,
  Check,
  Shield,
  PenLine,
  Lock,
  MapPin,
  Users,
  Camera,
  AlertTriangle,
  CheckCircle2,
  Download,
  ArrowLeft,
  RefreshCw,
  X,
} from "lucide-react";

interface MnemonicBackupDialogProps {
  open: boolean;
  mnemonic: string;
  onConfirm: () => void;
  onClose?: () => void;
}

const TOTAL_STEPS = 4;
const CHALLENGE_COUNT = 3;
const MIN_PASSWORD_LENGTH = 8;

export function MnemonicBackupDialog({
  open,
  mnemonic,
  onConfirm,
  onClose,
}: MnemonicBackupDialogProps) {
  const [step, setStep] = useState(1);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copied, setCopied] = useState(false);

  // Encrypted backup state
  const [showEncryptForm, setShowEncryptForm] = useState(false);
  const [encryptPassword, setEncryptPassword] = useState("");
  const [encryptConfirm, setEncryptConfirm] = useState("");
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [backupCreated, setBackupCreated] = useState(false);

  // Verification state
  const [challengeIndices, setChallengeIndices] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [hasAttempted, setHasAttempted] = useState(false);
  const [shakeFields, setShakeFields] = useState<boolean[]>([false, false, false]);

  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);

  // Determine if we can close the dialog (not during sensitive operations)
  const canClose = !isCreatingBackup;

  const handleClose = useCallback(() => {
    if (!canClose) return;
    if (onClose) {
      onClose();
    } else {
      onConfirm();
    }
  }, [canClose, onClose, onConfirm]);

  // Reset all state when dialog opens or closes
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
      setChallengeIndices([]);
      setAnswers(["", "", ""]);
      setHasAttempted(false);
      setShakeFields([false, false, false]);
    } else {
      // Clear sensitive state when dialog closes
      setEncryptPassword("");
      setEncryptConfirm("");
      setShowMnemonic(false);
      // Cancel any pending clipboard clear timer
      if (clipboardTimerRef.current) {
        clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = null;
      }
    }
  }, [open]);

  const generateChallengeIndices = useCallback(() => {
    const indices: number[] = [];
    while (indices.length < CHALLENGE_COUNT) {
      const idx = Math.floor(Math.random() * words.length);
      if (!indices.includes(idx)) indices.push(idx);
    }
    indices.sort((a, b) => a - b);
    setChallengeIndices(indices);
    setAnswers(["", "", ""]);
    setHasAttempted(false);
    setShakeFields([false, false, false]);
  }, [words.length]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Clear clipboard after 30 seconds for security
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = setTimeout(() => {
        navigator.clipboard.writeText("").catch((err: unknown) => console.warn("[MnemonicBackupDialog] Failed to clear clipboard:", err));
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
      const fileName = `hippius-recovery-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      const filePath = await save({
        filters: [{ name: "Zip Archive", extensions: ["zip"] }],
        defaultPath: saveDir ? `${saveDir}/${fileName}` : fileName,
      });

      if (!filePath) {
        // User cancelled save dialog
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

  const handleGoToStep3 = () => {
    generateChallengeIndices();
    setStep(3);
  };

  const checkAnswer = (index: number): boolean => {
    if (challengeIndices[index] === undefined) return false;
    return answers[index].toLowerCase().trim() === words[challengeIndices[index]].toLowerCase();
  };

  const handleVerify = () => {
    setHasAttempted(true);
    const allCorrect = challengeIndices.every(
      (wordIdx, i) => answers[i].toLowerCase().trim() === words[wordIdx].toLowerCase()
    );

    if (allCorrect) {
      setStep(4);
    } else {
      // Shake incorrect fields
      const newShake = challengeIndices.map(
        (wordIdx, i) => answers[i].toLowerCase().trim() !== words[wordIdx].toLowerCase()
      );
      setShakeFields(newShake);
      setTimeout(() => setShakeFields([false, false, false]), 300);
    }
  };

  const handleShuffle = () => {
    generateChallengeIndices();
  };

  const passwordsValid =
    encryptPassword.length >= MIN_PASSWORD_LENGTH &&
    encryptPassword === encryptConfirm;

  if (!mnemonic) return null;

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen && canClose) {
      handleClose();
    }
  };

  // Step icon and title mapping
  const stepConfig: Record<number, { icon: React.ReactNode; title: string }> = {
    1: { icon: <Shield className="size-5 text-grey-100" />, title: "Secure Your Mnemonic Seed" },
    2: { icon: <Eye className="size-5 text-grey-100" />, title: "Your Mnemonic Seed" },
    3: { icon: <CheckCircle2 className="size-5 text-grey-100" />, title: "Verify Your Mnemonic Seed" },
    4: { icon: <CheckCircle2 className="size-5 text-grey-100" />, title: "Mnemonic Seed Secured!" },
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[35rem] h-fit"
        preventClose={!canClose}
      >
        <Dialog.Title className="sr-only">{stepConfig[step]?.title}</Dialog.Title>

        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Header: Back button + Close button */}
          <div className="flex items-center justify-between">
            <div className="w-8">
              {step > 1 && step < 4 && (
                <button
                  type="button"
                  onClick={() => setStep(step - 1)}
                  className="flex items-center gap-1 text-sm text-grey-40 hover:text-grey-20 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleClose}
              disabled={!canClose}
              className="text-grey-50 hover:text-grey-20 transition-colors disabled:opacity-30"
            >
              <X className="size-5" />
            </button>
          </div>

          {/* Progress Bar */}
          <ProgressBar totalSteps={TOTAL_STEPS} currentStep={step} />

          {/* Icon Header — Graphsheet pattern (matching other dialogs) */}
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                {stepConfig[step]?.icon}
              </div>
            </div>
          </div>

          {/* Step 1: Security Best Practices */}
          {step === 1 && (
            <div className="animate-fade-in-from-b-0.3 flex flex-col gap-4">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-grey-10">
                  Secure Your Mnemonic Seed
                </h2>
                <Dialog.Description className="text-sm text-grey-50 mt-1 max-w-sm mx-auto">
                  Your mnemonic seed is the only way to restore access to your account and encrypted files.
                </Dialog.Description>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { icon: PenLine, text: "Write it on paper — never take a digital photo" },
                  { icon: Lock, text: "Store in a fireproof and waterproof safe" },
                  { icon: Users, text: "Never share it with anyone, including support staff" },
                  { icon: MapPin, text: "Keep copies in multiple secure locations" },
                  { icon: Camera, text: "Never store in email, cloud storage, or screenshots" },
                ].map(({ icon: Icon, text }, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3 rounded-lg bg-grey-90/50 border border-grey-80"
                  >
                    <Icon className="w-4 h-4 text-grey-30 flex-shrink-0" />
                    <span className="text-sm text-grey-20">{text}</span>
                  </div>
                ))}
              </div>

              <div className="bg-warning-50/10 border border-warning-50/30 rounded-lg p-3 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-warning-50 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-warning-50">
                  Make sure no one is watching your screen before proceeding.
                </p>
              </div>

              <Button onClick={() => setStep(2)} className="w-full">
                I Understand, Show My Mnemonic Seed
              </Button>
            </div>
          )}

          {/* Step 2: Display Mnemonic Seed */}
          {step === 2 && (
            <div className="animate-fade-in-from-b-0.3 flex flex-col gap-4">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-grey-10">
                  Your Mnemonic Seed
                </h2>
                <Dialog.Description className="text-sm text-grey-50 mt-1 max-w-sm mx-auto">
                  Write down each word in order. You&apos;ll need to verify them in the next step.
                </Dialog.Description>
              </div>

              {/* Word Grid */}
              <div className="bg-grey-90 rounded-lg p-4 relative">
                <div
                  className={`grid grid-cols-3 gap-2 transition-all duration-200 ${!showMnemonic ? "blur-md select-none" : ""
                    }`}
                >
                  {words.map((word, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-grey-100 rounded-md px-3 py-2 border border-grey-80"
                    >
                      <span className="text-grey-40 text-xs font-mono w-5 text-right">
                        {index + 1}.
                      </span>
                      <span className="text-sm font-medium">{word}</span>
                    </div>
                  ))}
                </div>

                {/* Show/Hide Overlay */}
                {!showMnemonic && (
                  <button
                    type="button"
                    onClick={() => setShowMnemonic(true)}
                    className="absolute inset-0 flex items-center justify-center bg-grey-90/60 rounded-lg cursor-pointer"
                  >
                    <div className="flex items-center gap-2 text-grey-20 bg-grey-80 px-4 py-2 rounded-md">
                      <Eye className="w-4 h-4" />
                      <span className="text-sm font-medium">Click to reveal</span>
                    </div>
                  </button>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setShowMnemonic(!showMnemonic)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-20 bg-grey-90 hover:bg-grey-80 rounded-md transition-colors border border-grey-80"
                >
                  {showMnemonic ? (
                    <>
                      <EyeOff className="w-4 h-4" /> Hide
                    </>
                  ) : (
                    <>
                      <Eye className="w-4 h-4" /> Show
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-20 bg-grey-90 hover:bg-grey-80 rounded-md transition-colors border border-grey-80"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-success-50" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" /> Copy
                    </>
                  )}
                </button>
                {!backupCreated && (
                  <button
                    type="button"
                    onClick={() => setShowEncryptForm(!showEncryptForm)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-grey-20 bg-grey-90 hover:bg-grey-80 rounded-md transition-colors border border-grey-80"
                  >
                    <Download className="w-4 h-4" />
                    {showEncryptForm ? "Cancel" : "Download Encrypted Backup"}
                  </button>
                )}
                {backupCreated && (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-success-50">
                    <CheckCircle2 className="w-4 h-4" /> Encrypted backup saved
                  </div>
                )}
              </div>

              {/* Encrypt Form */}
              {showEncryptForm && (
                <div className="animate-slideDown bg-grey-90 rounded-lg p-4 border border-grey-80 flex flex-col gap-3">
                  <p className="text-xs text-grey-40">
                    Encrypt your mnemonic seed with a password and save it as a file.
                  </p>
                  <div className="flex flex-col gap-2">
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder={`Password (min ${MIN_PASSWORD_LENGTH} characters)`}
                      value={encryptPassword}
                      onChange={(e) => setEncryptPassword(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-grey-100 border border-grey-80 rounded-md focus:outline-none focus:border-primary-50 transition-colors"
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
                      value={encryptConfirm}
                      onChange={(e) => setEncryptConfirm(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-grey-100 border border-grey-80 rounded-md focus:outline-none focus:border-primary-50 transition-colors"
                    />
                    {encryptPassword.length > 0 &&
                      encryptConfirm.length > 0 &&
                      encryptPassword !== encryptConfirm && (
                        <p className="text-xs text-error-50">Passwords do not match</p>
                      )}
                  </div>
                  <Button
                    onClick={handleEncryptedBackup}
                    disabled={!passwordsValid || isCreatingBackup}
                    className="w-full"
                    size="sm"
                  >
                    {isCreatingBackup ? "Encrypting..." : "Encrypt & Save"}
                  </Button>
                  <p className="text-xs text-grey-50">
                    Saves a password-protected zip file. Use 7-Zip or a compatible app to open it.
                  </p>
                </div>
              )}

              {/* Bottom Navigation */}
              <div className="flex justify-end mt-1">
                <Button onClick={handleGoToStep3}>
                  I Have Written It Down
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Verification Challenge */}
          {step === 3 && (
            <div className="animate-fade-in-from-b-0.3 flex flex-col gap-4">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-grey-10">
                  Verify Your Mnemonic Seed
                </h2>
                <Dialog.Description className="text-sm text-grey-50 mt-1 max-w-sm mx-auto">
                  Enter the requested words to confirm you&apos;ve saved your phrase correctly.
                </Dialog.Description>
              </div>

              <div className="flex flex-col gap-3">
                {challengeIndices.map((wordIdx, i) => {
                  const isCorrect = checkAnswer(i);
                  const isIncorrect = hasAttempted && !isCorrect && answers[i].trim().length > 0;

                  return (
                    <div key={`${wordIdx}-${i}`} className="flex flex-col gap-1">
                      <label className="text-sm text-grey-30 font-medium">
                        Word #{wordIdx + 1}
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          autoComplete="off"
                          placeholder={`Enter word #${wordIdx + 1}`}
                          value={answers[i]}
                          onChange={(e) => {
                            const newAnswers = [...answers];
                            newAnswers[i] = e.target.value;
                            setAnswers(newAnswers);
                          }}
                          className={`w-full px-3 py-2.5 text-sm bg-grey-100 border rounded-md focus:outline-none transition-colors pr-10 ${shakeFields[i] ? "animate-shake" : ""
                            } ${isCorrect && answers[i].trim().length > 0
                              ? "border-success-50"
                              : isIncorrect
                                ? "border-error-50"
                                : "border-grey-80 focus:border-primary-50"
                            }`}
                        />
                        {isCorrect && answers[i].trim().length > 0 && (
                          <Check className="w-4 h-4 text-success-50 absolute right-3 top-1/2 -translate-y-1/2" />
                        )}
                        {isIncorrect && (
                          <X className="w-4 h-4 text-error-50 absolute right-3 top-1/2 -translate-y-1/2" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={handleShuffle}
                  className="flex items-center gap-1.5 text-sm text-grey-40 hover:text-grey-20 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Shuffle words
                </button>
                <Button onClick={handleVerify}>
                  Verify
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Completion */}
          {step === 4 && (
            <div className="animate-fade-in-from-b-0.3 flex flex-col items-center gap-5 py-2">
              <div className="animate-scale-in-100%-0.3">
                <div className="w-16 h-16 rounded-full bg-success-50/10 flex items-center justify-center">
                  <CheckCircle2 className="w-9 h-9 text-success-50" />
                </div>
              </div>

              <div className="text-center">
                <h2 className="text-xl font-semibold text-grey-10">
                  Mnemonic Seed Secured!
                </h2>
                <Dialog.Description className="text-sm text-grey-50 mt-1 max-w-sm mx-auto">
                  Your mnemonic seed has been verified. Your files are protected.
                </Dialog.Description>
              </div>

              <div className="w-full bg-grey-90 rounded-lg p-4 flex flex-col gap-2.5 border border-grey-80">
                <div className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-success-50 flex-shrink-0" />
                  <span className="text-sm text-grey-20">Mnemonic seed viewed</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-success-50 flex-shrink-0" />
                  <span className="text-sm text-grey-20">Verification passed</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {backupCreated ? (
                    <Check className="w-4 h-4 text-success-50 flex-shrink-0" />
                  ) : (
                    <span className="w-4 h-4 flex items-center justify-center text-grey-50 text-xs flex-shrink-0">
                      —
                    </span>
                  )}
                  <span
                    className={`text-sm ${backupCreated ? "text-grey-20" : "text-grey-50"}`}
                  >
                    Encrypted backup {backupCreated ? "created" : "skipped"}
                  </span>
                </div>
              </div>

              <p className="text-xs text-grey-40 text-center max-w-xs">
                Keep your mnemonic seed safe. You will need it to restore access to your
                encrypted files on a new device.
              </p>

              <Button onClick={onConfirm} className="w-full">
                Done
              </Button>
            </div>
          )}
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
