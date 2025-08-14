/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, {
  useState,
  useRef,
  useCallback,
  DragEvent,
  ChangeEvent,
  useEffect,
} from "react";
import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AbstractIconWrapper,
  BackButton,
  Button,
  Icons,
  Input,
  RevealTextLine,
} from "@/components/ui";
import { Eye, EyeOff, Key } from "@/components/ui/icons";
import { InView } from "react-intersection-observer";
import BoxSimple from "@/components/ui/icons/BoxSimple";
import { restoreWalletFromZip } from "@/app/lib/helpers/restoreWallet";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

type FieldErrorState = {
  file?: string | null;
  passcode?: string | null;
};

const RestoreBackupForm: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [passCode, setPasscode] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<FieldErrorState>({});
  const [showPasscode, setShowPasscode] = useState(false);

  // drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { setSession } = useWalletAuth();

  const validateFile = (f: File | null) => {
    if (!f) return "Please select a backup file.";
    if (!f.name.endsWith(".zip")) return "Please select a valid zip file.";
    return null;
  };

  const validatePasscode = (p: string) => {
    if (!p) return "Please enter your passcode.";
    if (p.length < 8) return "Passcode must be at least 8 characters.";
    return null;
  };

  // Global listeners to clear dragging if leaving window
  useEffect(() => {
    const onWindowDragEnd = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDragging(false);
      }
    };
    window.addEventListener("dragend", onWindowDragEnd as any);
    window.addEventListener("drop", onWindowDragEnd as any);
    return () => {
      window.removeEventListener("dragend", onWindowDragEnd as any);
      window.removeEventListener("drop", onWindowDragEnd as any);
    };
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      setFile(droppedFile);
      setFieldError((prev) => ({ ...prev, file: validateFile(droppedFile) }));
      if (fileInput.current) fileInput.current.value = "";
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleClick = () => {
    fileInput.current?.click();
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setFieldError((prev) => ({ ...prev, file: validateFile(f) }));
  };

  const handlePasscodeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setPasscode(v);
    setFieldError((prev) => ({ ...prev, passcode: validatePasscode(v) }));
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    const fileErr = validateFile(file);
    const passErr = validatePasscode(passCode);
    setFieldError({ file: fileErr, passcode: passErr });
    if (fileErr || passErr) return;

    setRestoring(true);
    setError("");
    try {
      const result = await restoreWalletFromZip(file!, passCode);
      if (result.success && result.mnemonic) {
        await setSession(result.mnemonic);
        router.push("/");
      } else {
        setError(result.error || "Failed to restore wallet");
      }
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full flex flex-col">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full flex flex-col">
            <form
              onSubmit={handleRestore}
              className="flex flex-col xl:gap-5 gap-3"
            >
              {/* Heading */}
              <div className="flex flex-col xl:gap-3 gap-1 mb-1">
                <div className="text-grey-10 xl:text-[32px] text-2xl font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Restore your Hippius Account
                  </RevealTextLine>
                </div>
                <div className="text-grey-50 xl:text-base text-xs font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Upload your backup file and enter your passcode to restore
                    your Hippius account
                  </RevealTextLine>
                </div>
              </div>

              {/* File Drop Zone */}
              <div className="flex flex-col xl:gap-4 gap-2">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <BackButton href={"login"} text="Back" />
                </RevealTextLine>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-500 w-full"
                >
                  <div
                    className={cn(
                      "w-full rounded-lg xl:h-[180px] h-[120px] xl:p-3 p-1 transition",
                      isDragging
                        ? "bg-gray-50 border-2 border-dashed border-primary-50"
                        : "border border-grey-80"
                    )}
                  >
                    <div
                      className="cursor-pointer border border-grey-80 rounded-xl border-dashed flex flex-col items-center justify-center h-full w-full transition"
                      onClick={handleClick}
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragEnter={handleDragEnter}
                      onDragLeave={handleDragLeave}
                    >
                      <div className="mb-2">
                        <AbstractIconWrapper className="size-8">
                          <BoxSimple className="size-5 text-primary-50 absolute" />
                        </AbstractIconWrapper>
                      </div>
                      {file ? (
                        <div className="text-base font-medium text-grey-50 border border-grey-80 rounded-lg py-1 px-2 gap-4 my-2 relative">
                          {file.name}
                          <div
                            className="absolute right-[-6px] top-[-6px]"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFile(null);
                              setFieldError((prev) => ({
                                ...prev,
                                file: null,
                              }));
                              if (fileInput.current)
                                fileInput.current.value = "";
                            }}
                          >
                            <Icons.CloseCircle className="size-4 text-grey-50" />
                          </div>
                        </div>
                      ) : (
                        <div className="text-base font-medium text-grey-10">
                          Upload a File Here
                        </div>
                      )}
                      <div className="text-grey-60 text-sm font-medium">
                        Drag & drop or click to add file
                      </div>
                      <input
                        ref={fileInput}
                        type="file"
                        accept=".zip"
                        className="hidden"
                        onChange={handleChange}
                      />
                    </div>
                  </div>
                </RevealTextLine>
                {fieldError.file && (
                  <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{fieldError.file}</span>
                  </div>
                )}
              </div>

              {/* Passcode */}
              <div className="xl:space-y-2 space-y-1 text-grey-10 w-full flex flex-col">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <Label
                    htmlFor="passcode"
                    className="text-sm font-medium text-grey-70"
                  >
                    Passcode
                  </Label>
                </RevealTextLine>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-500 w-full"
                >
                  <div className="relative flex items-start w-full">
                    <Key className="size-6 absolute left-3 top-[28px] -translate-y-1/2 text-grey-60" />
                    <Input
                      id="passcode"
                      placeholder="Passcode"
                      type={showPasscode ? "text" : "password"}
                      value={passCode}
                      onChange={handlePasscodeChange}
                      className="pl-11 border-grey-80 h-14 text-grey-30 w-full bg-grey-100 py-4 font-medium text-base rounded-lg outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                    />
                    {!showPasscode ? (
                      <Eye
                        onClick={() => setShowPasscode(true)}
                        className="size-6 absolute right-3 top-[28px] -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    ) : (
                      <EyeOff
                        onClick={() => setShowPasscode(false)}
                        className="size-6 absolute right-3 top-[28px] -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    )}
                  </div>
                </RevealTextLine>
                {fieldError.passcode && (
                  <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{fieldError.passcode}</span>
                  </div>
                )}
                {error && (
                  <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              {/* Submit */}
              <div className="flex flex-col w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <Button
                    type="submit"
                    className="w-full h-[48px] text-white font-medium text-lg"
                    disabled={restoring}
                    icon={<Icons.ArrowRight />}
                  >
                    {restoring ? "Restoring Account..." : "Restore Account"}
                  </Button>
                </RevealTextLine>
              </div>
            </form>
          </div>
        </div>
      )}
    </InView>
  );
};

export default RestoreBackupForm;
