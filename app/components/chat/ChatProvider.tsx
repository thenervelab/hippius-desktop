"use client";

/**
 * Owns the Matrix client for the chat page.
 *
 * Lifecycle: ask Rust for the stored session (OS keyring) -> start the
 * client -> once syncing, check whether encryption is set up on this
 * device; if not, fetch the mnemonic-derived secret-storage key from Rust
 * and bootstrap silently. Sign-in is Rust's OIDC flow: `chat_begin_sign_in`
 * gives a URL the system browser opens, `chat_complete_sign_in` blocks on
 * the loopback redirect and returns the persisted session.
 *
 * Everything Matrix-specific is in `app/lib/chat/`; everything that is a
 * credential is in Rust (`app/lib/tauri/chat.ts`); this file is only the
 * React binding. Ported from the console's `ChatProvider`, minus what a
 * single-window desktop app does not have: the cross-tab lock
 * (`held-elsewhere`) and the "unlock the console" mnemonic gate — the
 * desktop account is unlocked for as long as it is signed in.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SyncState } from "matrix-js-sdk";

import {
  type ChatClientHandle,
  signOutChat,
  startChatClient,
  stopChatClient,
} from "@/app/lib/chat/client";
import {
  type BackupSummary,
  type BootstrapOptions,
  type BootstrapOutcome,
  bootstrapEncryption,
  encryptionNeedsBootstrap,
} from "@/app/lib/chat/crypto/bootstrap";
import {
  clearSecretStorageKey,
  decodeSecretStorageKey,
} from "@/app/lib/chat/crypto/secret-storage-keys";
import {
  type ChatSession,
  chatBeginSignIn,
  chatCancelSignIn,
  chatCompleteSignIn,
  chatDeriveSecretStorageKey,
  chatGetSession,
  isChatKeyringUnavailable,
} from "@/app/lib/tauri/chat";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { openExternalLink } from "@/app/lib/utils/tauri";

export type ChatConnection =
  | { kind: "booting" }
  | { kind: "signed-out" }
  /** The system browser is open on the sign-in page; Rust waits for the redirect. */
  | { kind: "signing-in" }
  /**
   * The stored session could not be read at all (the OS credential store
   * is unreachable). Not "signed out": offering a sign-in here would fail
   * again at the keyring write, so the UI offers a retry only.
   */
  | { kind: "unavailable"; message: string }
  | { kind: "connecting"; session: ChatSession }
  | { kind: "ready"; session: ChatSession; handle: ChatClientHandle }
  | { kind: "error"; message: string; session: ChatSession | null };

export type ChatEncryption =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "bootstrapping" }
  | {
      kind: "ready";
      warnings: string[];
      /** Null when no bootstrap ran in this session (the device was already set up). */
      backup: BackupSummary | null;
      /** Room keys imported from the backup by the bootstrap that just ran. */
      restoredKeys: number;
    }
  /**
   * Set up, but this device is not signed by the self-signing key: other
   * devices withhold room keys from it. `selfSigningKeyAvailable` means a
   * re-run (`unlockEncryption`) can sign it here; otherwise the user must
   * verify it from another device.
   */
  | {
      kind: "device-unsigned";
      selfSigningKeyAvailable: boolean;
      detail: string;
      warnings: string[];
      backup: BackupSummary;
      restoredKeys: number;
    }
  | { kind: "foreign-key"; keyId: string; keyName?: string; canAdopt: boolean }
  | {
      kind: "cross-signing-blocked";
      accountManagementUrl?: string;
      detail: string;
    }
  | { kind: "error"; message: string };

/**
 * Repairs the user can ask for from the encryption UI. Each one re-runs the
 * bootstrap with a freshly fetched key.
 */
export type EncryptionRepair =
  /** Foreign default key + private keys cached here: make the derived key the default. */
  | "adopt-derived-key"
  /** New cross-signing keys; other devices must be verified again. */
  | "reset-cross-signing"
  /** A backup whose key we cannot read: replace it with one we own. */
  | "replace-backup";

export function optionsForRepair(repair: EncryptionRepair): BootstrapOptions {
  switch (repair) {
    case "adopt-derived-key":
      return { mode: "adopt-derived-key" };
    case "reset-cross-signing":
      return { mode: "reset-cross-signing" };
    case "replace-backup":
      return { replaceUnreadableBackup: true };
  }
}

export function encryptionFromOutcome(
  outcome: BootstrapOutcome,
): ChatEncryption {
  switch (outcome.status) {
    case "ready":
      return {
        kind: "ready",
        warnings: outcome.warnings,
        backup: outcome.backup,
        restoredKeys: outcome.restoredKeys,
      };
    case "device-unsigned":
      return {
        kind: "device-unsigned",
        selfSigningKeyAvailable: outcome.selfSigningKeyAvailable,
        detail: outcome.detail,
        warnings: outcome.warnings,
        backup: outcome.backup,
        restoredKeys: outcome.restoredKeys,
      };
    case "foreign-key":
      return {
        kind: "foreign-key",
        keyId: outcome.keyId,
        keyName: outcome.keyName,
        canAdopt: outcome.canAdopt,
      };
    case "cross-signing-blocked":
      return {
        kind: "cross-signing-blocked",
        accountManagementUrl: outcome.accountManagementUrl,
        detail: outcome.detail,
      };
  }
}

/** One line per outcome, for the console: what happened, what is still missing. */
function describeOutcome(outcome: BootstrapOutcome): string {
  switch (outcome.status) {
    case "ready":
      return `ready (createdSecretStorage=${outcome.createdSecretStorage}, createdBackup=${outcome.createdBackup}, signedDevice=${outcome.signedDevice}, restoredKeys=${outcome.restoredKeys}, backup=${outcome.backup.version ?? "none"}/${outcome.backup.readable ? "readable" : "unreadable"}${outcome.warnings.length ? `, warnings: ${outcome.warnings.join(" | ")}` : ""})`;
    case "device-unsigned":
      return `device-unsigned (selfSigningKeyAvailable=${outcome.selfSigningKeyAvailable}; ${outcome.detail}${outcome.warnings.length ? `; warnings: ${outcome.warnings.join(" | ")}` : ""})`;
    case "foreign-key":
      return `foreign-key (keyId=${outcome.keyId}, name=${outcome.keyName ?? "?"}, canAdopt=${outcome.canAdopt})`;
    case "cross-signing-blocked":
      return `cross-signing-blocked (${outcome.detail}; approve at ${outcome.accountManagementUrl ?? "unknown"})`;
  }
}

/** Tell Rust to drop or abort a sign-in flow; a failure is only logged. */
async function abortFlowInRust(flowId: string): Promise<void> {
  try {
    await chatCancelSignIn(flowId);
  } catch (error) {
    console.warn(`[chat] cancel sign-in: ${errorMessage(error)}`);
  }
}

export interface ChatContextValue {
  connection: ChatConnection;
  encryption: ChatEncryption;
  syncState: SyncState | null;
  /** Open the system browser on the sign-in page and wait for it to come back. */
  signIn: () => Promise<void>;
  /** Abandon a sign-in the user backed out of. */
  cancelSignIn: () => Promise<void>;
  /** Revoke tokens, wipe local chat data, return to signed-out. */
  signOut: () => Promise<void>;
  /** After a failed boot: start the client again with the stored session. */
  retry: () => void;
  /** Fetch the key from Rust and (re)run the encryption bootstrap. */
  unlockEncryption: () => void;
  /** Fetch the key from Rust and re-run the bootstrap with a repair. */
  repairEncryption: (repair: EncryptionRepair) => void;
  /** Convenience: the running client, or null. */
  client: ChatClientHandle["client"] | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChat must be used inside <ChatProvider>");
  return value;
}

/**
 * Owns the Matrix client for the whole signed-in app. Mounted once in the
 * protected layout (`ChatHost`), not per route, so the client keeps
 * syncing while the user is on Files or Wallet — that is what makes
 * notifications and the unread badge work off the chat page.
 *
 * `active` is the Rust feature gate (`chat_get_config().enabled`). While
 * false nothing boots and the connection stays `booting`; the tree shape is
 * the same either way so the gate landing after first paint never remounts
 * the app under it.
 */
export function ChatProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const [connection, setConnection] = useState<ChatConnection>({
    kind: "booting",
  });
  const [encryption, setEncryption] = useState<ChatEncryption>({
    kind: "unknown",
  });
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  // Bumped by `retry()` and by a completed sign-in: re-runs the boot effect,
  // which tears down whatever the previous attempt left behind.
  const [bootAttempt, setBootAttempt] = useState(0);
  const handleRef = useRef<ChatClientHandle | null>(null);
  /**
   * The sign-in in progress, one object per attempt so a continuation can
   * tell (by identity) whether it still owns the UI; `flowId` is Rust's
   * handle once `chat_begin_sign_in` has answered. Cancel must work before
   * that answer too — begin runs discovery, metadata and client
   * registration over the network — so a cancel clears the attempt, not a
   * flow id: a flow id that arrives for a cancelled attempt is aborted in
   * Rust straight away, and the browser is never opened for it.
   */
  const signInRef = useRef<{ flowId: string | null } | null>(null);

  // -- boot: session -> client ------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let started: ChatClientHandle | null = null;

    setConnection({ kind: "booting" });
    setEncryption({ kind: "unknown" });
    setSyncState(null);
    if (!active) return;

    const stopStarted = () => {
      if (started) {
        stopChatClient(started);
        started = null;
      }
      handleRef.current = null;
    };

    (async () => {
      let session: ChatSession | null;
      try {
        session = await chatGetSession();
      } catch (error) {
        if (cancelled) return;
        const message = errorMessage(error);
        console.warn(`[chat] could not read the stored session: ${message}`);
        setConnection(
          isChatKeyringUnavailable(error)
            ? { kind: "unavailable", message }
            : { kind: "error", message, session: null },
        );
        return;
      }
      if (cancelled) return;
      if (!session) {
        setConnection({ kind: "signed-out" });
        return;
      }

      setConnection({ kind: "connecting", session });
      try {
        const handle = await startChatClient(session, {
          onSyncState: (state) => setSyncState(state),
          onSessionExpired: () => {
            // The SDK reached this through the token refresher: Rust said
            // the refresh token is dead and has already forgotten the
            // session. Nothing this client sends can succeed any more, so
            // stop it rather than let it retry behind the error screen;
            // `retry()` finds no session and lands on sign-in.
            if (cancelled) return;
            stopStarted();
            setConnection({
              kind: "error",
              message:
                "Your chat session has expired. Sign in again to continue.",
              session,
            });
          },
        });
        if (cancelled) {
          stopChatClient(handle);
          return;
        }
        started = handle;
        handleRef.current = handle;
        await handle.ready;
        if (cancelled) return;
        setConnection({ kind: "ready", session, handle });
      } catch (error) {
        if (cancelled) return;
        // The client never reached its first sync: stop it so it does not
        // keep retrying behind the error screen, and let `retry()` start a
        // fresh one.
        stopStarted();
        setConnection({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not connect to the chat server.",
          session,
        });
      }
    })();

    return () => {
      cancelled = true;
      stopStarted();
    };
  }, [bootAttempt, active]);

  const retry = useCallback(() => setBootAttempt((n) => n + 1), []);

  // -- encryption: check, then bootstrap silently -----------------------
  // One bootstrap at a time: the automatic check and a user-triggered
  // repair can land within one tick.
  const bootstrapInFlight = useRef(false);
  // A bootstrap outlives the provider when chat is signed out (or the user
  // logs out) mid-run; its result must not be written into a gone component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runBootstrap = useCallback(async (options: BootstrapOptions = {}) => {
    const handle = handleRef.current;
    if (!handle) return;
    if (bootstrapInFlight.current) {
      console.info(
        "[chat/crypto] bootstrap already running; ignoring a second request",
      );
      return;
    }
    bootstrapInFlight.current = true;
    console.info(
      `[chat/crypto] bootstrap start (mode=${options.mode ?? "auto"}, replaceUnreadableBackup=${options.replaceUnreadableBackup === true})`,
    );
    setEncryption({ kind: "bootstrapping" });
    let key: Uint8Array<ArrayBuffer> | null = null;
    try {
      // The key is Rust's to derive; fetched right before use and zeroed
      // right after. The holder keeps its own copy for the SDK's callbacks
      // until the client stops.
      const material = await chatDeriveSecretStorageKey();
      key = decodeSecretStorageKey(material.keyBase64);
      // Where the homeserver sends the user to approve a cross-signing
      // reset; the server's own answer (MSC3967) wins when it gives one.
      const accountManagementUrl = await handle.client
        .getAuthMetadata()
        .then((m) => m.account_management_uri ?? undefined)
        .catch(() => undefined);
      const outcome = await bootstrapEncryption(
        handle.client,
        { key, keyId: material.keyId, keyName: material.keyName },
        { accountManagementUrl, ...options },
      );
      console.info(
        `[chat/crypto] bootstrap outcome: ${describeOutcome(outcome)}`,
      );
      if (mounted.current) setEncryption(encryptionFromOutcome(outcome));
    } catch (error) {
      const message = errorMessage(error) || "Encryption setup failed.";
      console.info(`[chat/crypto] bootstrap failed: ${message}`);
      if (mounted.current) setEncryption({ kind: "error", message });
    } finally {
      key?.fill(0);
      bootstrapInFlight.current = false;
    }
  }, []);

  // Once per connected client: is this device set up? Keyed on the
  // connection alone — depending on `encryption.kind` here would cancel
  // the check it started (the `checking` state re-runs the effect, whose
  // cleanup flips `cancelled` before the crypto reads come back).
  useEffect(() => {
    if (connection.kind !== "ready") return;
    let cancelled = false;
    setEncryption({ kind: "checking" });
    (async () => {
      let needs: boolean;
      try {
        needs = await encryptionNeedsBootstrap(connection.handle.client);
      } catch (error) {
        if (cancelled) return;
        const message =
          errorMessage(error) || "Could not read the encryption state.";
        console.info(`[chat/crypto] check failed: ${message}`);
        setEncryption({ kind: "error", message });
        return;
      }
      if (cancelled) return;
      if (!needs) {
        console.info(
          "[chat/crypto] check: this device is set up (cross-signing, secret storage, backup, device signed); nothing to do",
        );
        setEncryption({
          kind: "ready",
          warnings: [],
          backup: null,
          restoredKeys: 0,
        });
        return;
      }
      console.info("[chat/crypto] check: setup needed; bootstrapping now");
      await runBootstrap();
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, runBootstrap]);

  const unlockEncryption = useCallback(() => {
    void runBootstrap();
  }, [runBootstrap]);

  const repairEncryption = useCallback(
    (repair: EncryptionRepair) => {
      void runBootstrap(optionsForRepair(repair));
    },
    [runBootstrap],
  );

  // -- sign in / out -----------------------------------------------------
  const signIn = useCallback(async () => {
    if (signInRef.current) return;
    const current = { flowId: null as string | null };
    signInRef.current = current;
    const live = () => signInRef.current === current;
    setConnection({ kind: "signing-in" });
    try {
      const begun = await chatBeginSignIn();
      if (!live()) {
        // Cancelled while Rust was still preparing the flow: it exists in
        // Rust now, so abort it there, and never open the browser for it.
        void abortFlowInRust(begun.flowId);
        return;
      }
      current.flowId = begun.flowId;
      await openExternalLink(begun.authorizeUrl);
      // Blocks until the browser comes back (or the Rust-side timeout).
      // Rust persisted the session before answering, so the boot effect
      // finds it in the keyring.
      await chatCompleteSignIn(begun.flowId);
      if (!live()) return; // cancelled meanwhile
      signInRef.current = null;
      setBootAttempt((n) => n + 1);
    } catch (error) {
      if (!live()) return; // cancelled meanwhile
      signInRef.current = null;
      setConnection({
        kind: "error",
        message: errorMessage(error) || "Could not start sign-in.",
        session: null,
      });
    }
  }, []);

  const cancelSignIn = useCallback(async () => {
    const inFlight = signInRef.current;
    signInRef.current = null;
    setConnection({ kind: "signed-out" });
    if (inFlight?.flowId) await abortFlowInRust(inFlight.flowId);
    // With no flow id yet, `signIn` aborts the flow itself when begin
    // answers: it sees the attempt is no longer live.
  }, []);

  const signOut = useCallback(async () => {
    const session =
      connection.kind === "ready" ||
      connection.kind === "connecting" ||
      connection.kind === "error"
        ? connection.session
        : null;
    const handle = handleRef.current;
    handleRef.current = null;
    setConnection({ kind: "booting" });
    setEncryption({ kind: "unknown" });
    setSyncState(null);
    try {
      await signOutChat(handle, session);
    } catch (error) {
      console.warn(`[chat] sign-out: ${errorMessage(error)}`);
    }
    clearSecretStorageKey();
    setConnection({ kind: "signed-out" });
  }, [connection]);

  // Nothing derived from the account outlives the client.
  useEffect(() => () => clearSecretStorageKey(), []);

  const value = useMemo<ChatContextValue>(
    () => ({
      connection,
      encryption,
      syncState,
      signIn,
      cancelSignIn,
      signOut,
      retry,
      unlockEncryption,
      repairEncryption,
      client: connection.kind === "ready" ? connection.handle.client : null,
    }),
    [
      connection,
      encryption,
      syncState,
      signIn,
      cancelSignIn,
      signOut,
      retry,
      unlockEncryption,
      repairEncryption,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
