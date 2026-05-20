"use client";

import React, { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle, Loader2, X } from "lucide-react";

/* Bottom-right minimized toast used by every wallet transaction flow
 * (Send / Stake / Unstake / Withdraw / Bridge) to surface
 * pending / success / error state without blocking the dialog
 * underneath. Ported from the hippius-web console so both products
 * share an identical pending → outcome surface.
 *
 * The component is config-driven so each caller supplies the per-state
 * title / description / optional action. The accent border color falls
 * back to a sensible per-state default if not overridden.
 *
 * Renders through a portal to document.body so it escapes any parent
 * stacking context (z-indexed wrappers etc. on the wallet page). */

export type TransactionFlowState = "idle" | "pending" | "success" | "error";

export interface TransactionFlowToastConfig {
  /** Accent color for the outer border. Defaults based on state. */
  accentColor?: string;
  /** Title text for each state */
  title: string;
  /** Description text for each state */
  description: string;
  /** Optional action button (e.g. "Try Again"). Rendered below text. */
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface TransactionFlowToastProps {
  /** Current flow state */
  state: "pending" | "success" | "error";
  /** Config map keyed by state */
  config: Record<string, TransactionFlowToastConfig>;
  /** Called when X is pressed to dismiss */
  onDismiss: () => void;
  /** Optional custom icon override */
  icon?: ReactNode;
}

const defaultAccentColors: Record<string, string> = {
  pending: "#3167dd",
  success: "#04C870",
  error: "#FC7D73",
};

const defaultIcons: Record<string, ReactNode> = {
  pending: (
    <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-[#3167dd]" />
  ),
  success: <CheckCircle className="mt-0.5 size-5 shrink-0 text-[#04C870]" />,
  error: <AlertCircle className="mt-0.5 size-5 shrink-0 text-[#FC7D73]" />,
};

const TransactionFlowToast: React.FC<TransactionFlowToastProps> = ({
  state,
  config,
  onDismiss,
  icon,
}) => {
  const stateConfig = config[state];
  if (!stateConfig) return null;

  const accentColor = stateConfig.accentColor ?? defaultAccentColors[state];
  const stateIcon = icon ?? defaultIcons[state];

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed bottom-4 left-4 right-4 z-50 sm:left-auto sm:right-4 animate-in slide-in-from-bottom-4 duration-300">
      <div
        className="w-full sm:w-[380px] rounded-[16px] p-2.5 sm:p-3 shadow-lg"
        style={{ backgroundColor: accentColor }}
      >
        <div className="flex flex-col gap-2.5 rounded-[10px] bg-white px-3 py-2.5 sm:px-4 sm:py-3 dark:bg-[#1e1e1e]">
          <div className="flex items-start gap-2.5 sm:gap-3">
            {stateIcon}

            <div className="min-w-0 flex-1">
              <p className="text-[13px] sm:text-[14px] font-semibold leading-5 text-[#0a0a0a] dark:text-white">
                {stateConfig.title}
              </p>
              <p className="mt-0.5 text-[12px] sm:text-[13px] leading-[17px] sm:leading-[18px] text-[#7d7d7d] dark:text-grey-dark-600">
                {stateConfig.description}
              </p>
            </div>

            {state !== "pending" && (
              <button
                type="button"
                onClick={onDismiss}
                className="mt-0.5 shrink-0 text-[#a0a0a0] hover:text-[#4f4f4f] dark:hover:text-white"
              >
                <X className="size-5" />
              </button>
            )}
          </div>

          {stateConfig.action && (
            <button
              type="button"
              onClick={stateConfig.action.onClick}
              className="w-full rounded-[6px] bg-[#2b2b2b] px-3 py-2 text-[12px] sm:text-[13px] font-medium text-white hover:bg-[#1f1f1f] dark:bg-[#3a3a3a] dark:hover:bg-[#444]"
            >
              {stateConfig.action.label}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default React.memo(TransactionFlowToast);
