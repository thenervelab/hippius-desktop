"use client";

import { MessagesSquare } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ChatSignedOutProps {
  onSignIn: () => Promise<void>;
  /** Rust is waiting on the browser redirect: show that, offer a cancel. */
  signingIn?: boolean;
  onCancel?: () => Promise<void>;
  /** A previous attempt failed: show why, keep the single CTA. */
  errorMessage?: string;
}

/**
 * Signed-out state. One action: the OIDC flow runs in the system browser
 * (Rust's `chat_begin_sign_in` / `chat_complete_sign_in`), so there is
 * nothing to type here — chat identity is the Hippius account, already
 * signed in. Ported from the console's `ChatSignedOut`, plus the
 * "waiting for the browser" state the desktop has and the web does not.
 */
export default function ChatSignedOut({
  onSignIn,
  signingIn = false,
  onCancel,
  errorMessage,
}: ChatSignedOutProps) {
  return (
    <div className="flex h-full min-h-[480px] w-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-40">
          <MessagesSquare className="size-7" aria-hidden />
        </div>
        <h2 className="text-xl font-medium text-grey-10 dark:text-grey-light-100">Team chat</h2>
        <p className="mt-2 text-sm text-grey-60 dark:text-grey-dark-700">
          End-to-end encrypted channels and direct messages for your team. Messages are readable
          only on your devices; the server never sees the contents.
        </p>
        {signingIn ? (
          <p className="mt-3 text-sm text-grey-60 dark:text-grey-dark-700" role="status">
            Finish signing in with your browser. This page updates on its own when you are done.
          </p>
        ) : (
          <p className="mt-3 text-sm text-grey-60 dark:text-grey-dark-700">
            Sign in with your Hippius account.
          </p>
        )}
        {errorMessage ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-error-50 bg-error-50/10 px-3 py-2 text-sm text-error-50 dark:border-error-40 dark:bg-error-50/20 dark:text-error-40"
          >
            {errorMessage}
          </p>
        ) : null}
        {signingIn ? (
          <Button
            variant="defaultStable"
            size="sm"
            className="mt-6"
            onClick={() => void onCancel?.()}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="primary" size="sm" className="mt-6" onClick={() => void onSignIn()}>
            Open team chat
          </Button>
        )}
      </div>
    </div>
  );
}
