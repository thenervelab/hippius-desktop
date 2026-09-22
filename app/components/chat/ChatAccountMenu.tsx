"use client";

import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { LogOut, MonitorSmartphone, Settings } from "lucide-react";
import { toast } from "sonner";

import { openExternalLink } from "@/app/lib/utils/tauri";
import ChatMenu, { type ChatMenuItem } from "@/components/chat/ChatMenu";
import { useChat } from "@/components/chat/ChatProvider";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { CHAT_SIGN_OUT_CONFIRM, CHAT_SIGN_OUT_HEADING, sessionsListUrl } from "@/lib/chat/sign-out";

interface ChatAccountMenuProps {
  client: MatrixClient;
  /** Extra entries placed before the sign-out group (e.g. Preferences). */
  extraItems?: readonly ChatMenuItem[];
}

/**
 * The account menu in the sidebar header: who is signed in to the chat,
 * where the identity provider lists the account's other devices, and the
 * sign-out — reachable without opening a dialog. Mirrors the console's
 * account menu; the confirm is the app's `ConfirmationDialog` rather than
 * `window.confirm`, which the webview does not render reliably.
 *
 * "Sign out other devices" is an IdP page (MSC2965 `sessions_list`): a
 * client cannot revoke the other devices itself, so the entry only appears
 * once the server has advertised an account-management URL.
 */
export default function ChatAccountMenu({ client, extraItems = [] }: ChatAccountMenuProps) {
  const { signOut } = useChat();
  const myUserId = client.getUserId() ?? "";
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionsUrl, setSessionsUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getAuthMetadata()
      .then((m) => {
        if (!cancelled) setSessionsUrl(sessionsListUrl(m.account_management_uri));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const doSignOut = async () => {
    setBusy(true);
    try {
      await signOut();
      setConfirming(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  };

  const items: (ChatMenuItem | "separator")[] = [...extraItems];
  if (sessionsUrl) {
    items.push({
      key: "other-devices",
      label: "Sign out other devices",
      icon: MonitorSmartphone,
      onSelect: () => void openExternalLink(sessionsUrl),
    });
  }
  if (items.length > 0) items.push("separator");
  items.push({
    key: "sign-out",
    label: "Sign out of chat",
    icon: LogOut,
    destructive: true,
    onSelect: () => setConfirming(true),
  });

  return (
    <>
      <ChatMenu
        header={
          <span className="block min-w-0">
            <span className="block text-[10px] uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">Signed in as</span>
            <span className="block truncate font-mono text-xs" title={myUserId}>
              {myUserId}
            </span>
          </span>
        }
        items={items}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
            aria-label={`Chat account: signed in as ${myUserId}`}
          >
            <Settings className="size-4" aria-hidden />
          </Button>
        }
      />
      <ConfirmationDialog
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        onBack={() => !busy && setConfirming(false)}
        onConfirm={() => void doSignOut()}
        heading={CHAT_SIGN_OUT_HEADING}
        text={CHAT_SIGN_OUT_CONFIRM}
        button={busy ? "Signing out…" : "Sign out"}
        disableButton={busy}
        disableBackButton={busy}
        icon={<LogOut className="size-5 text-white" aria-hidden />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
      />
    </>
  );
}
