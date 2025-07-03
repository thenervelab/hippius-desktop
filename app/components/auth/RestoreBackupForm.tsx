"use client";

import { useState, useRef } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AbstractIconWrapper,
  Button,
  Icons,
  Input,
  RevealTextLine,
} from "../ui";
import { Eye, EyeOff, Key } from "../ui/icons";
import { InView } from "react-intersection-observer";
import BoxSimple from "../ui/icons/BoxSimple";
import Link from "next/link";

const RestoreBackupForm: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [passCode, setPasscode] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const handleClick = () => fileInput.current?.click();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleRestore = () => {
    setRestoring(true);
    console.log("handle restore");
    setError("");
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full flex flex-col">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full  flex flex-col">
            <form
              onSubmit={handleRestore}
              className="flex flex-col xl:gap-5 gap-3"
            >
              <div className="flex flex-col xl:gap-3 gap-1 mb-1">
                <div className="text-grey-10 xl:text-[32px] text-2xl font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Restore your Hippius Account
                  </RevealTextLine>
                </div>
                <div className="text-grey-50 xl:text-base text-xs font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Here is your seed phrase to gain access to your Hippius
                    account, please store it somewhere and continue
                  </RevealTextLine>
                </div>
              </div>
              <div className="flex flex-col xl:gap-4 gap-2">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <div className="text-lg font-medium flex items-center gap-2 text-grey-10">
                    <Link href="/signup">
                      <Icons.ArrowLeft className="size-6" />
                    </Link>
                    <div>Upload your file</div>
                  </div>
                </RevealTextLine>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-500 w-full"
                >
                  <div
                    className="w-full border border-grey-80 rounded-lg xl:h-[180px] h-[120px]
                  xl:p-3 p-1 transition"
                  >
                    <div
                      className="cursor-pointer border border-grey-80 rounded-xl
                  border-dashed flex flex-col items-center justify-center h-full w-full transition"
                      onClick={handleClick}
                      onDrop={handleDrop}
                      onDragOver={(e) => e.preventDefault()}
                    >
                      <div className="mb-2">
                        <AbstractIconWrapper className="size-8">
                          <BoxSimple className="size-5 text-primary-50 absolute" />
                        </AbstractIconWrapper>
                      </div>
                      {file ? (
                        <div
                          className="text-base font-medium text-grey-50 border border-grey-80 
                      rounded-lg py-1 px-2 gap-4 my-2 relative"
                        >
                          {file?.name}
                          <div
                            className="absolute right-[-6px] top-[-6px]"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFile(null);
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
                        Drag and drop or click to add file here to upload
                      </div>
                      <input
                        ref={fileInput}
                        type="file"
                        className="hidden"
                        onChange={handleChange}
                      />
                    </div>
                  </div>
                </RevealTextLine>
              </div>
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
                    <Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                    <Input
                      id="passcode"
                      placeholder="Passcode"
                      type={showPasscode ? "text" : "password"}
                      value={passCode}
                      onChange={(e) => setPasscode(e.target.value)}
                      className="pl-11 border-grey-80 h-14 text-grey-30 w-full
                                  bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                                  hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                    />
                    {!showPasscode ? (
                      <Eye
                        onClick={() => setShowPasscode(true)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    ) : (
                      <EyeOff
                        onClick={() => setShowPasscode(false)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    )}
                  </div>
                </RevealTextLine>
              </div>

              {error && (
                <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex flex-col w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <Button
                    type="submit"
                    className={cn(
                      "w-full h-[60px] text-white font-medium text-lg"
                    )}
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
