"use client";

import type { FC, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderSync } from "lucide-react";

import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Button } from "@/components/ui/button";
import ConfettiCanvas from "@/components/ui/ConfettiCanvas";
import { ArrowLeft } from "@/components/ui/icons";
import PixelGridLoader from "@/components/ui/PixelGridLoader";
import { formatPlanStorage, type DrivePlan } from "@/lib/types/drive-plans";
import { cn } from "@/lib/utils";

export type DrivePlanFlowStage = "processing" | "success" | "error";

export interface DrivePlanFlow {
  stage: DrivePlanFlowStage;
  plan: DrivePlan;
  /** Only shown on the error stage. */
  message?: string;
}

interface DrivePlanFlowDialogProps {
  flow: DrivePlanFlow | null;
  onContinue: () => void;
  onRetry: () => void;
  onBack: () => void;
}

/**
 * The framed card every stage sits in: the same shell as `FramedDialog`
 * without its header badge and title. Red on the error stage, so the colour
 * says what happened before the text does.
 */
const Shell: FC<{
  open: boolean;
  tone: "primary" | "error";
  /** Left out on stages that must not be dismissed, e.g. while writing. */
  onClose?: () => void;
  children: ReactNode;
}> = ({ open, tone, onClose, children }) => (
  <Dialog.Root
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose?.();
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-white/72 backdrop-blur-[5.75px] dark:bg-[rgba(4,4,4,0.4)] dark:backdrop-blur-[11.5px]" />
      <Dialog.Content
        className="fixed left-0 right-0 top-0 z-50 flex h-[100dvh] flex-col p-3 sm:p-6"
        onClick={onClose}
        onEscapeKeyDown={(e) => {
          if (!onClose) e.preventDefault();
        }}
      >
        <BackgroundContainer
          className="relative z-[1] mx-auto my-auto w-full sm:w-fit"
          fillClassName="fill-[#f9f9f9] dark:fill-[#262626]"
          hippoIconClassName="fill-[#989898] dark:fill-[#5e5e5e]"
          borderClassName={tone === "error" ? "bg-[#fc7d73]" : "bg-primary-50"}
          contentClassName="flex justify-center px-0 py-0 sm:px-8 sm:py-8"
          shellClassName="w-full min-w-0 max-w-[660px] sm:min-w-0 sm:max-w-[660px]"
          cardClassName="w-full min-w-0 max-w-full gap-0 bg-white p-0 dark:bg-[#161616]"
          stopClickPropagation
          addDotWithBlurryEffect
          isDialog
        >
          <div className="relative mx-auto flex min-h-[420px] w-full flex-col overflow-hidden p-4 sm:min-h-[480px] sm:w-[565px] sm:max-w-[calc(100vw-168px)]">
            {children}
          </div>
        </BackgroundContainer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

const Status: FC<{
  tone: "primary" | "error";
  label: string;
  detail?: string;
}> = ({ tone, label, detail }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-10">
    <PixelGridLoader tone={tone} />
    <div className="flex flex-col items-center gap-2">
      <p className="text-center text-[20px] font-medium tracking-[-0.4px] text-[#1d1d1d]/50 dark:text-grey-light-100/50">
        {label}
      </p>
      {detail ? (
        <p className="max-w-[420px] text-center text-sm font-medium text-grey-50 dark:text-grey-dark-700">
          {detail}
        </p>
      ) : null}
    </div>
  </div>
);

const StorageGlyph: FC<{ bytes: number }> = ({ bytes }) => {
  const [amount, unit] = formatPlanStorage(bytes).split(" ");
  return (
    <span className="flex size-[38px] shrink-0 flex-col items-center justify-center rounded-[7px] bg-[#f9f9f9] leading-none dark:bg-black-300">
      <span className="text-[13px] font-semibold tracking-[-0.26px] text-primary-50 dark:text-primary-brand-dark">
        {amount}
      </span>
      <span className="text-[8px] font-semibold text-primary-50 dark:text-primary-brand-dark">
        {unit}
      </span>
    </span>
  );
};

const Perk: FC<{
  icon: ReactNode;
  title: string;
  text: string;
  className?: string;
}> = ({ icon, title, text, className }) => (
  <div className={cn("flex items-center gap-3 px-4", className)}>
    {icon}
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
      <p className="tracking-[-0.36px] text-black-900 dark:text-grey-light-100">
        {title}
      </p>
      <p className="leading-[14px] text-[#a6a6ab]">{text}</p>
    </div>
  </div>
);

/**
 * What the user sees from confirming a plan to having it. Processing cannot
 * be dismissed: the write is in flight and closing the card would only hide
 * that, not stop it. Success and error can.
 */
const DrivePlanFlowDialog: FC<DrivePlanFlowDialogProps> = ({
  flow,
  onContinue,
  onRetry,
  onBack,
}) => {
  if (!flow) return null;

  if (flow.stage === "processing") {
    return (
      <Shell open tone="primary">
        <Dialog.Title className="sr-only">Processing your plan</Dialog.Title>
        <Status tone="primary" label="Processing..." />
      </Shell>
    );
  }

  if (flow.stage === "error") {
    return (
      <Shell open tone="error" onClose={onBack}>
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="absolute left-4 top-4 inline-flex size-[19px] items-center justify-center text-grey-10 opacity-50 transition-opacity hover:opacity-100 dark:text-grey-light-100"
        >
          <ArrowLeft className="size-[19px]" />
        </button>
        <Dialog.Title className="sr-only">Encountered an error</Dialog.Title>
        <Status
          tone="error"
          label="Encountered an error"
          detail={flow.message}
        />
        <Button
          variant="destructive"
          className="h-[52px] w-full font-normal text-white"
          onClick={onRetry}
        >
          Try again
        </Button>
      </Shell>
    );
  }

  return (
    <Shell open tone="primary" onClose={onContinue}>
      <ConfettiCanvas className="absolute inset-x-0 top-0 h-[55%] w-full" />
      <div className="relative flex flex-col items-center gap-5 pt-[43px]">
        <Dialog.Title className="text-center text-[28px] font-medium leading-9 text-black-700/60 dark:text-grey-light-100/60">
          You&rsquo;re subscribed to
        </Dialog.Title>
        <p className="bg-gradient-to-r from-[#2f2f2f] via-[#7a7a7a] to-[#3d3d3d] bg-clip-text text-center text-[56px] font-semibold leading-[0.85] tracking-[-0.04em] text-transparent sm:text-[80px] dark:from-[#f2f2f2] dark:via-[#9a9a9a] dark:to-[#e0e0e0]">
          {flow.plan.name} Plan
        </p>
      </div>
      <div className="relative mt-auto flex flex-col gap-[27px] pt-8">
        <div className="flex flex-col overflow-hidden rounded-[14px] bg-[#f4f4f4] dark:bg-black-500">
          <Perk
            className="border-b border-[#f9f9f9] pb-1.5 pt-[15px] dark:border-black-300"
            icon={<StorageGlyph bytes={flow.plan.storage_bytes} />}
            title="More space for what matters"
            text="Store without worrying about running out of space."
          />
          <Perk
            className="pb-4 pt-1.5"
            icon={
              <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[7px] bg-[#f9f9f9] dark:bg-black-300">
                <FolderSync className="size-4 text-primary-50 dark:text-primary-brand-dark" />
              </span>
            }
            title="Access & Sync"
            text="Securely synced across your devices, files are always available."
          />
        </div>
        <Button
          variant="primary"
          className="h-[52px] w-full font-normal"
          onClick={onContinue}
        >
          Continue
        </Button>
      </div>
    </Shell>
  );
};

export default DrivePlanFlowDialog;
