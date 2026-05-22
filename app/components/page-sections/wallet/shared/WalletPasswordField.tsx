"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface WalletPasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Error text shown under the field. Pass `null` / `undefined` to hide. */
  error?: string | null;
  disabled?: boolean;
  /** Auto-focus the input once when this transitions to `true` — usually
   *  bound to the parent dialog's `open` prop so the field grabs focus
   *  as soon as the dialog mounts. */
  autoFocusOnOpen?: boolean;
  /** Optional handler for the Enter key; usually wired to the parent's
   *  "submit" action so the user can confirm via keyboard. */
  onSubmit?: () => void;
  /** Tweak the rendered `id` when multiple instances share a page. */
  id?: string;
}

/**
 * Password input + show/hide toggle + inline error. Used by every wallet
 * confirmation dialog (Send, Stake, Unstake, Withdraw) so the password
 * prompt lives in-line with the action summary instead of in a separate
 * follow-up modal. The parent owns `verifyPassword` + the success/error
 * handling — this component is presentation only.
 */
const WalletPasswordField = forwardRef<
  HTMLInputElement,
  WalletPasswordFieldProps
>(
  (
    {
      value,
      onChange,
      error,
      disabled,
      autoFocusOnOpen,
      onSubmit,
      id = "wallet-password-field",
    },
    ref,
  ) => {
    const [show, setShow] = useState(false);
    const innerRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    // Focus the password field once per `open=true` transition; the
    // 30 ms timeout lets the dialog finish its enter animation before
    // we grab focus, so the focus ring doesn't paint over a still-
    // animating shell.
    useEffect(() => {
      if (!autoFocusOnOpen) return;
      const t = setTimeout(() => innerRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }, [autoFocusOnOpen]);

    return (
      <div className="space-y-2">
        <label
          htmlFor={id}
          className="block text-sm font-medium text-[#6c6c6c] dark:text-grey-dark-700"
        >
          Wallet Password
        </label>
        <div className="relative">
          <Input
            id={id}
            ref={innerRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && onSubmit) {
                e.preventDefault();
                onSubmit();
              }
            }}
            type={show ? "text" : "password"}
            placeholder="Enter your wallet password"
            autoComplete="current-password"
            disabled={disabled}
            wrapperClassName="!shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none"
            className={cn("pr-10", error && "border-error-50")}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            disabled={disabled}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 dark:text-grey-dark-600 disabled:opacity-50"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {error ? (
          <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
            <AlertCircle className="size-4" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    );
  },
);

WalletPasswordField.displayName = "WalletPasswordField";

export default WalletPasswordField;
