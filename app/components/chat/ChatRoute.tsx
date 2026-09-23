"use client";

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import { useChat } from "@/components/chat/ChatProvider";
import ChatSignedOut from "@/components/chat/ChatSignedOut";
import ChatShell from "@/components/chat/ChatShell";
import { Button } from "@/components/ui/button";

/**
 * Entry point for `/chat`. Runtime-gated on Rust's `chat_get_config`:
 * while the answer is unknown nothing renders (no redirect either — a
 * flash to the overview on every cold load would be wrong); once known
 * and disabled the route is client-side replaced with the overview, like
 * `FeatureDisabledRedirect` does for build-time flags.
 *
 * The chat client itself is not started here: `ChatHost` in the protected
 * layout owns the `ChatProvider` for the whole signed-in session (so
 * notifications and the unread badge work off this page); this route only
 * reads its context.
 */
export default function ChatRoute() {
  const config = useAtomValue(chatConfigAtom);
  const router = useRouter();
  const enabled = config?.enabled === true;

  useEffect(() => {
    if (config && !enabled) router.replace("/");
  }, [config, enabled, router]);

  if (!enabled) return null;
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <ChatBody />
    </div>
  );
}

function ChatBody() {
  const { connection, signIn, cancelSignIn, signOut, retry } = useChat();

  switch (connection.kind) {
    case "booting":
    case "connecting":
      return (
        <div
          className="flex h-full min-h-[480px] w-full items-center justify-center p-6 text-sm text-grey-60 dark:text-grey-dark-700"
          role="status"
        >
          Connecting to chat…
        </div>
      );

    case "signed-out":
      return <ChatSignedOut onSignIn={signIn} />;

    case "signing-in":
      return (
        <ChatSignedOut onSignIn={signIn} signingIn onCancel={cancelSignIn} />
      );

    case "unavailable":
      // The keyring could not be read. Not a sign-in problem: offering the
      // button here would fail again at the keyring write.
      return <Unavailable message={connection.message} onRetry={retry} />;

    case "error":
      if (!connection.session) {
        return (
          <ChatSignedOut onSignIn={signIn} errorMessage={connection.message} />
        );
      }
      return (
        <Unavailable
          message={connection.message}
          onRetry={retry}
          onSignOut={signOut}
        />
      );

    case "ready":
      return <ChatShell client={connection.handle.client} />;
  }
}

function Unavailable({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut?: () => Promise<void>;
}) {
  return (
    <div className="flex h-full min-h-[480px] w-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <h2 className="text-lg font-medium text-grey-10 dark:text-grey-light-100">
          Chat is unavailable
        </h2>
        <p
          role="alert"
          className="mt-2 text-sm text-grey-60 dark:text-grey-dark-700"
        >
          {message}
        </p>
        <div className="mt-6 flex gap-3">
          {onSignOut ? (
            <Button
              variant="defaultStable"
              size="sm"
              onClick={() => void onSignOut()}
            >
              Sign out of chat
            </Button>
          ) : null}
          <Button variant="primary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
