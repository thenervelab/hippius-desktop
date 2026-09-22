"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import {
  Bell,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  Pencil,
  Settings,
  Volume2,
  ShieldCheck,
  ShieldOff,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { openExternalLink } from "@/app/lib/utils/tauri";
import {
  autoplayGifsAtom,
  type ChatSettingsTab,
  chatSettingsOpenAtom,
} from "@/components/chat/chat-ui-atoms";
import { useChat } from "@/components/chat/ChatProvider";
import {
  dialogContentClassName,
  dialogTabPanelClassName,
  dialogTabsClassName,
  dialogTitleClassName,
  dialogToggleRowClassName,
} from "@/components/chat/dialog-styles";
import EncryptionDiagnostics from "@/components/chat/EncryptionDiagnostics";
import ToggleSwitch from "@/components/chat/ToggleSwitch";
import UserAvatar from "@/components/chat/UserAvatar";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import FramedDialog from "@/components/ui/FramedDialog";
import { chimeSupported, playChime } from "@/lib/chat/chime";
import {
  type DeviceRow,
  listOwnDevices,
  recoveryKeyText,
} from "@/lib/chat/settings";
import {
  CHAT_SIGN_OUT_CONFIRM,
  CHAT_SIGN_OUT_HEADING,
  sessionsListUrl,
} from "@/lib/chat/sign-out";
import { formatDayLabel, formatTime } from "@/lib/chat/timeline";
import {
  chatGetNotificationsEnabled,
  chatGetSoundEnabled,
  chatSetNotificationsEnabled,
  chatSetSoundEnabled,
} from "@/lib/tauri/chat";
import { cn } from "@/lib/utils";

type Tab = ChatSettingsTab;

const TABS: { id: Tab; label: string; icon: typeof Bell }[] = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "notifications", label: "Notifications & media", icon: Bell },
  { id: "encryption", label: "Encryption", icon: KeyRound },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
];

const FIELD =
  "w-full rounded-md border border-grey-80 bg-white px-2.5 py-1.5 text-sm text-grey-10 outline-none placeholder:text-grey-60 focus:border-primary-50 dark:border-black-300 dark:bg-black-300 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700 dark:focus:border-primary-40";
const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border border-grey-80 px-2.5 py-1 text-xs font-medium text-grey-10 hover:bg-grey-90 disabled:opacity-50 dark:border-black-300 dark:text-grey-light-100 dark:hover:bg-black-300";

/**
 * Slack-style preferences dialog: account, notifications & media,
 * encryption, devices. Ported from the console with the desktop's rules:
 * the notification and sound switches are Rust preferences (the policy
 * lives in `chat::notify`), the recovery key comes from Rust rather than a
 * mnemonic prompt, external pages open in the system browser, and every
 * confirmation is the app's `ConfirmationDialog` (the webview does not
 * render `window.confirm` reliably).
 */
export default function ChatSettingsDialog({
  client,
}: {
  client: MatrixClient;
}) {
  const [open, setOpen] = useAtom(chatSettingsOpenAtom);
  // The section asked for when opening wins; browsing inside the dialog
  // then moves freely.
  const [tab, setTab] = useState<Tab>("account");
  useEffect(() => {
    if (open) setTab(open);
  }, [open]);
  const close = () => setOpen(false);

  return (
    <FramedDialog
      open={open !== false}
      onClose={close}
      title="Preferences"
      icon={<Settings className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[760px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      <div className={dialogTabsClassName}>
        <nav
          className="flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col"
          aria-label="Preference sections"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-grey-10 hover:bg-grey-90 dark:text-grey-light-100 dark:hover:bg-black-300",
                tab === id && "bg-grey-90 font-medium dark:bg-black-300",
              )}
            >
              <Icon
                className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
                aria-hidden
              />
              {label}
            </button>
          ))}
        </nav>
        <div className={dialogTabPanelClassName}>
          {tab === "account" ? (
            <AccountTab client={client} onClose={close} />
          ) : null}
          {tab === "notifications" ? <NotificationsTab /> : null}
          {tab === "encryption" ? <EncryptionTab client={client} /> : null}
          {tab === "devices" ? <DevicesTab client={client} /> : null}
        </div>
      </div>
    </FramedDialog>
  );
}

// ---------------------------------------------------------------------------

function AccountTab({
  client,
  onClose,
}: {
  client: MatrixClient;
  onClose: () => void;
}) {
  const { signOut } = useChat();
  const me = client.getUserId() ?? "";
  const user = client.getUser(me);
  const [name, setName] = useState(user?.displayName ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"name" | "signout" | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Where the IdP lists this account's sessions: "sign out everywhere" is
  // an IdP action, not something a client can do for the other devices.
  const [sessionsUrl, setSessionsUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    client
      .getAuthMetadata()
      .then((m) => {
        if (!cancelled)
          setSessionsUrl(sessionsListUrl(m.account_management_uri));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === user?.displayName) {
      setEditing(false);
      return;
    }
    setBusy("name");
    try {
      await client.setDisplayName(next);
      setEditing(false);
      toast.success("Display name updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update name",
      );
    } finally {
      setBusy(null);
    }
  };

  const doSignOut = async () => {
    setBusy("signout");
    try {
      await signOut();
      setConfirming(false);
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not sign out",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <UserAvatar
          client={client}
          seed={me}
          avatarMxc={user?.avatarUrl ?? null}
          size={56}
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setEditing(false);
                }}
                autoFocus
                aria-label="Display name"
                className={FIELD}
              />
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={busy === "name"}
                className={SMALL_BUTTON}
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <p className="truncate text-base font-semibold text-grey-10 dark:text-grey-light-100">
                {user?.displayName ?? me}
              </p>
              <button
                type="button"
                onClick={() => {
                  setName(user?.displayName ?? "");
                  setEditing(true);
                }}
                aria-label="Edit display name"
                className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
          <p className="truncate font-mono text-xs text-grey-60 dark:text-grey-dark-700">
            {me}
          </p>
        </div>
      </div>

      <div className="space-y-3 border-t border-grey-80 pt-4 dark:border-black-300">
        <div>
          <p className="mb-2 text-xs text-grey-60 dark:text-grey-dark-700">
            Signing out revokes this device&apos;s chat session and deletes its
            local message cache, keys and drafts.
          </p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy === "signout"}
            className={cn(SMALL_BUTTON, "text-error-50 dark:text-error-50")}
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out of chat
          </button>
        </div>
        {sessionsUrl ? (
          <div>
            <p className="mb-2 text-xs text-grey-60 dark:text-grey-dark-700">
              Other devices signed in to this chat account are managed by the
              identity provider, where each can be signed out.
            </p>
            <button
              type="button"
              onClick={() => void openExternalLink(sessionsUrl)}
              className={SMALL_BUTTON}
            >
              <MonitorSmartphone className="size-3.5" aria-hidden />
              Sign out other devices
            </button>
          </div>
        ) : null}
      </div>

      <ConfirmationDialog
        open={confirming}
        onClose={() => busy !== "signout" && setConfirming(false)}
        onBack={() => busy !== "signout" && setConfirming(false)}
        onConfirm={() => void doSignOut()}
        heading={CHAT_SIGN_OUT_HEADING}
        text={CHAT_SIGN_OUT_CONFIRM}
        button={busy === "signout" ? "Signing out…" : "Sign out"}
        disableButton={busy === "signout"}
        disableBackButton={busy === "signout"}
        icon={<LogOut className="size-5 text-white" aria-hidden />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Both switches are Rust preferences read on mount; the toggle is
 * optimistic and rolled back on an IPC failure. The rule itself (mentions
 * in channels, every direct message) is Rust's and is only described here.
 */
function NotificationsTab() {
  const [notify, setNotify] = useState<boolean | null>(null);
  const [sound, setSound] = useState<boolean | null>(null);
  const [autoplayGifs, setAutoplayGifs] = useAtom(autoplayGifsAtom);

  useEffect(() => {
    let cancelled = false;
    Promise.all([chatGetNotificationsEnabled(), chatGetSoundEnabled()])
      .then(([n, s]) => {
        if (cancelled) return;
        setNotify(n);
        setSound(s);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error("Could not load notification preferences");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleNotify = (next: boolean) => {
    const previous = notify;
    setNotify(next);
    chatSetNotificationsEnabled(next).catch(() => {
      setNotify(previous);
      toast.error("Could not save the notification preference");
    });
  };
  const toggleSound = (next: boolean) => {
    const previous = sound;
    setSound(next);
    chatSetSoundEnabled(next).catch(() => {
      setSound(previous);
      toast.error("Could not save the sound preference");
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-grey-10 dark:text-grey-light-100">
          Notifications
        </h3>
        <div className={cn(dialogToggleRowClassName, "mt-2")}>
          <span>
            <span className="block text-sm text-grey-10 dark:text-grey-light-100">
              Desktop notifications
            </span>
            <span className="block text-xs text-grey-60 dark:text-grey-dark-700">
              When someone mentions you in a channel, and for every direct
              message. Badges in the sidebar still update when off.
            </span>
          </span>
          <ToggleSwitch
            checked={notify === true}
            disabled={notify === null}
            onChange={toggleNotify}
            ariaLabel="Desktop notifications"
          />
        </div>
        <div className={cn(dialogToggleRowClassName, "mt-2")}>
          <span>
            <span className="block text-sm text-grey-10 dark:text-grey-light-100">
              Sound
            </span>
            <span className="block text-xs text-grey-60 dark:text-grey-dark-700">
              Play a short chime with each notification.
            </span>
          </span>
          <span className="flex items-center gap-2">
            {chimeSupported() ? (
              <button
                type="button"
                onClick={() => void playChime()}
                className={SMALL_BUTTON}
                aria-label="Preview the notification sound"
              >
                <Volume2 className="size-3.5" aria-hidden /> Preview
              </button>
            ) : null}
            <ToggleSwitch
              checked={sound === true}
              disabled={sound === null || notify === false}
              onChange={toggleSound}
              ariaLabel="Notification sound"
            />
          </span>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-grey-10 dark:text-grey-light-100">
          Media
        </h3>
        <div className={cn(dialogToggleRowClassName, "mt-2")}>
          <span>
            <span className="block text-sm text-grey-10 dark:text-grey-light-100">
              Autoplay GIFs
            </span>
            <span className="block text-xs text-grey-60 dark:text-grey-dark-700">
              Animate GIFs in the timeline. When off, a still frame is shown and
              the GIF plays on hover.
            </span>
          </span>
          <ToggleSwitch
            checked={autoplayGifs}
            onChange={setAutoplayGifs}
            ariaLabel="Autoplay GIFs"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type PendingRepair = "reset-cross-signing" | "replace-backup" | null;

const REPAIR_COPY: Record<
  NonNullable<PendingRepair>,
  { heading: string; text: string; button: string }
> = {
  "reset-cross-signing": {
    heading: "Reset encryption for this account?",
    text: "New signing keys are created and stored under your mnemonic. Your other chat devices will show as unverified until they unlock with the mnemonic again. Messages already on this device are kept.",
    button: "Reset encryption",
  },
  "replace-backup": {
    heading: "Replace the message backup?",
    text: "The existing backup was created by another app with a key this device cannot read. It is deleted and a new one, readable with your mnemonic, takes its place. Messages that only exist in the old backup cannot be recovered afterwards.",
    button: "Replace backup",
  },
};

function EncryptionTab({ client }: { client: MatrixClient }) {
  const { encryption, unlockEncryption, repairEncryption } = useChat();
  const [key, setKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pendingRepair, setPendingRepair] = useState<PendingRepair>(null);

  const reveal = () => {
    setLoading(true);
    recoveryKeyText()
      .then((text) => {
        if (!text) throw new Error("Could not derive the recovery key");
        setKey(text);
        setRevealed(true);
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not derive the recovery key",
        ),
      )
      .finally(() => setLoading(false));
  };

  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };

  const confirmRepair = () => {
    if (!pendingRepair) return;
    repairEncryption(pendingRepair);
    setPendingRepair(null);
  };

  // Outcomes that ran the backup step and can report on it.
  const report =
    encryption.kind === "ready" || encryption.kind === "device-unsigned"
      ? encryption
      : null;
  const unreadableBackup =
    report !== null && report.backup !== null && !report.backup.readable;

  const status =
    encryption.kind === "ready"
      ? unreadableBackup
        ? {
            icon: ShieldCheck,
            tone: "text-warning-50 dark:text-warning-50",
            label: "Encryption is set up; message backup is not readable here",
            detail:
              "This device is verified and new messages are encrypted. A message backup exists, but it was created by another app with a key this device cannot read, so history from before this device cannot be restored.",
          }
        : {
            icon: ShieldCheck,
            tone: "text-success-50 dark:text-success-50",
            label: "Encryption is set up on this device",
            detail:
              "Private channels and direct messages are end-to-end encrypted. Keys are backed up under your mnemonic.",
          }
      : encryption.kind === "device-unsigned"
        ? {
            icon: ShieldOff,
            tone: "text-warning-50 dark:text-warning-50",
            label: "This device is not verified",
            detail: `${encryption.detail} Your other devices will not share encrypted messages with this one until it is signed. ${
              encryption.selfSigningKeyAvailable
                ? "The signing key is on this device: verify it now."
                : "Verify it from one of your other devices, or unlock chat there so this device can pick up the signing keys, then try again."
            }`,
          }
        : encryption.kind === "unknown" ||
            encryption.kind === "checking" ||
            encryption.kind === "bootstrapping"
          ? {
              icon: ShieldOff,
              tone: "text-warning-50 dark:text-warning-50",
              label:
                encryption.kind === "bootstrapping"
                  ? "Setting up encryption…"
                  : "Encryption is not set up yet",
              detail:
                "Set up encryption to read encrypted history and verify this device.",
            }
          : encryption.kind === "foreign-key"
            ? {
                icon: ShieldOff,
                tone: "text-warning-50 dark:text-warning-50",
                label: "Secret storage uses another key",
                detail: `This account's secret storage was set up elsewhere with a different recovery key${encryption.keyName ? ` (“${encryption.keyName}”)` : ""}. ${
                  encryption.canAdopt
                    ? "This device holds the signing keys, so it can switch the account to your Hippius key without a reset; the other key keeps working."
                    : "This device does not hold the signing keys. Either unlock with that recovery key in another client first, or reset encryption for this account."
                }`,
              }
            : encryption.kind === "cross-signing-blocked"
              ? {
                  icon: ShieldOff,
                  tone: "text-error-50 dark:text-error-50",
                  label: "Device verification needs approval",
                  detail: encryption.detail,
                }
              : {
                  icon: ShieldOff,
                  tone: "text-error-50 dark:text-error-50",
                  label: "Encryption error",
                  detail: encryption.kind === "error" ? encryption.message : "",
                };
  const StatusIcon = status.icon;
  const repairCopy = pendingRepair ? REPAIR_COPY[pendingRepair] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border border-grey-80 p-3 dark:border-black-300">
        <StatusIcon
          className={cn("mt-0.5 size-5 shrink-0", status.tone)}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
            {status.label}
          </p>
          <p className="mt-0.5 text-xs text-grey-60 dark:text-grey-dark-700">
            {status.detail}
          </p>
          {encryption.kind === "unknown" || encryption.kind === "checking" ? (
            <button
              type="button"
              onClick={unlockEncryption}
              className={cn(SMALL_BUTTON, "mt-2")}
            >
              <KeyRound className="size-3.5" aria-hidden />
              Set up encryption
            </button>
          ) : null}
          {encryption.kind === "foreign-key" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {encryption.canAdopt ? (
                <button
                  type="button"
                  onClick={() => repairEncryption("adopt-derived-key")}
                  className={SMALL_BUTTON}
                >
                  <KeyRound className="size-3.5" aria-hidden />
                  Use my Hippius key
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setPendingRepair("reset-cross-signing")}
                className={cn(SMALL_BUTTON, "text-error-50 dark:text-error-50")}
              >
                <ShieldOff className="size-3.5" aria-hidden />
                Reset encryption for this account
              </button>
            </div>
          ) : null}
          {unreadableBackup ? (
            <button
              type="button"
              onClick={() => setPendingRepair("replace-backup")}
              className={cn(
                SMALL_BUTTON,
                "mt-2 text-error-50 dark:text-error-50",
              )}
            >
              <ShieldOff className="size-3.5" aria-hidden />
              Replace message backup
            </button>
          ) : null}
          {encryption.kind === "cross-signing-blocked" ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {encryption.accountManagementUrl ? (
                <button
                  type="button"
                  onClick={() =>
                    void openExternalLink(encryption.accountManagementUrl ?? "")
                  }
                  className="text-xs text-primary-50 hover:underline dark:text-primary-40"
                >
                  Open account management
                </button>
              ) : null}
              <button
                type="button"
                onClick={unlockEncryption}
                className={SMALL_BUTTON}
              >
                Try again
              </button>
            </div>
          ) : null}
          {encryption.kind === "device-unsigned" ? (
            <button
              type="button"
              onClick={unlockEncryption}
              className={cn(SMALL_BUTTON, "mt-2")}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
              {encryption.selfSigningKeyAvailable
                ? "Verify this device"
                : "Try again"}
            </button>
          ) : null}
          {encryption.kind === "error" ? (
            <button
              type="button"
              onClick={unlockEncryption}
              className={cn(SMALL_BUTTON, "mt-2")}
            >
              Try again
            </button>
          ) : null}
          {report && report.restoredKeys > 0 ? (
            <p className="mt-2 text-xs text-grey-60 dark:text-grey-dark-700">
              Restored {report.restoredKeys} message{" "}
              {report.restoredKeys === 1 ? "key" : "keys"} from the backup.
            </p>
          ) : null}
          {report && report.warnings.length > 0 ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-warning-50 dark:text-warning-50">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-grey-10 dark:text-grey-light-100">
          Recovery key
        </h3>
        <p className="mt-1 text-xs text-grey-60 dark:text-grey-dark-700">
          Derived from your account. Enter it in another Matrix client (Element,
          for instance) as the security key to read your encrypted messages
          there. Anyone with this key can read them — treat it like your
          mnemonic.
        </p>
        {key && revealed ? (
          <div className="mt-2 flex items-start gap-2">
            <code className="flex-1 select-all break-all rounded-md border border-grey-80 bg-grey-light-600 p-2 font-mono text-xs text-grey-10 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-light-100">
              {key}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy recovery key"
              className={SMALL_BUTTON}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => setRevealed(false)}
              aria-label="Hide recovery key"
              className={SMALL_BUTTON}
            >
              <EyeOff className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={key ? () => setRevealed(true) : reveal}
            disabled={loading}
            className={cn(SMALL_BUTTON, "mt-2")}
          >
            <Eye className="size-3.5" aria-hidden />
            {key ? "Show recovery key" : "Reveal recovery key"}
          </button>
        )}
      </div>

      <EncryptionDiagnostics client={client} />

      <ConfirmationDialog
        open={pendingRepair !== null}
        onClose={() => setPendingRepair(null)}
        onBack={() => setPendingRepair(null)}
        onConfirm={confirmRepair}
        heading={repairCopy?.heading ?? ""}
        text={repairCopy?.text ?? ""}
        button={repairCopy?.button ?? ""}
        icon={<ShieldOff className="size-5 text-white" aria-hidden />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function DevicesTab({ client }: { client: MatrixClient }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [accountUrl, setAccountUrl] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listOwnDevices(client)
      .then(setDevices)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not load devices"),
      );
  }, [client]);

  useEffect(() => {
    load();
    let cancelled = false;
    client
      .getAuthMetadata()
      .then((m) => {
        if (!cancelled) setAccountUrl(m.account_management_uri ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, load]);

  const rename = async (deviceId: string) => {
    const next = nameDraft.trim();
    setRenaming(null);
    if (!next) return;
    try {
      await client.setDeviceDetails(deviceId, { display_name: next });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename device");
    }
  };

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-error-50 dark:text-error-50">{error}</p>
        <button type="button" onClick={load} className={SMALL_BUTTON}>
          Retry
        </button>
      </div>
    );
  }
  if (!devices) {
    return (
      <ul className="animate-pulse space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-14 rounded-md bg-grey-90 dark:bg-black-300"
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {devices.map((d) => (
          <li
            key={d.deviceId}
            className="flex items-start gap-3 rounded-md border border-grey-80 p-3 dark:border-black-300"
          >
            <MonitorSmartphone
              className="mt-0.5 size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              {renaming === d.deviceId ? (
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void rename(d.deviceId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(d.deviceId);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  autoFocus
                  aria-label="Device name"
                  className={FIELD}
                />
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-grey-10 dark:text-grey-light-100">
                  <span className="truncate font-medium">{d.displayName}</span>
                  {d.isCurrent ? (
                    <span className="rounded bg-grey-90 px-1.5 py-0.5 text-[10px] font-medium uppercase text-grey-60 dark:bg-black-300 dark:text-grey-dark-700">
                      This device
                    </span>
                  ) : null}
                  {d.isCurrent ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(d.displayName);
                        setRenaming(d.deviceId);
                      }}
                      aria-label="Rename this device"
                      className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
                    >
                      <Pencil className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </p>
              )}
              <p className="mt-0.5 truncate font-mono text-[11px] text-grey-60 dark:text-grey-dark-700">
                {d.deviceId}
                {d.lastSeenTs
                  ? ` · last seen ${formatDayLabel(d.lastSeenTs)} ${formatTime(d.lastSeenTs)}`
                  : ""}
                {d.lastSeenIp ? ` · ${d.lastSeenIp}` : ""}
              </p>
            </div>
            {d.verified === null ? null : d.verified ? (
              <span className="inline-flex items-center gap-1 text-xs text-success-50 dark:text-success-50">
                <ShieldCheck className="size-3.5" aria-hidden />
                Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-warning-50 dark:text-warning-50">
                <ShieldOff className="size-3.5" aria-hidden />
                Unverified
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-grey-60 dark:text-grey-dark-700">
        Devices verify themselves when they set up encryption.{" "}
        {accountUrl ? (
          <>
            To sign out another device,{" "}
            <button
              type="button"
              onClick={() => void openExternalLink(accountUrl)}
              className="text-primary-50 hover:underline dark:text-primary-40"
            >
              open account management
            </button>
            .
          </>
        ) : null}
      </p>
    </div>
  );
}
