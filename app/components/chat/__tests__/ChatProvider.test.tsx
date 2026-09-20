import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatProvider, useChat } from "@/components/chat/ChatProvider";
import { clearSecretStorageKey } from "@/app/lib/chat/crypto/secret-storage-keys";
import {
  defaultKeyId,
  DEVICE,
  makeClient,
  makeWorld,
  OUR_KEY,
  OUR_KEY_ID,
  OUR_KEY_NAME,
  secretUnder,
  USER,
  type World,
} from "@/app/lib/chat/crypto/testing/fake-world";
import type { ChatSession } from "@/app/lib/tauri/chat";

/**
 * The provider against the fake homeserver, with Rust replaced by the IPC
 * mock. Everything below the provider that talks to the network
 * (`startChatClient`, `signOutChat`) is replaced; the encryption bootstrap
 * and the server model are real, so the decisions the provider takes on a
 * fresh device are the ones production takes.
 */

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const openExternalLink = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock("@/app/lib/utils/tauri", () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));

const SESSION: ChatSession = {
  baseUrl: "https://matrix.example.org",
  issuer: "https://auth.example.org/",
  clientId: "client",
  userId: USER,
  deviceId: DEVICE,
  accessToken: "access",
  refreshToken: "refresh",
  storeLayout: "device",
};

let world: World;
const clientMock = vi.hoisted(() => ({
  startChatClient: vi.fn(),
  stopChatClient: vi.fn(),
  signOutChat: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/chat/client", () => clientMock);

function Probe() {
  const { connection, encryption, signIn, cancelSignIn, signOut, retry } = useChat();
  return (
    <>
      <output data-testid="connection">{connection.kind}</output>
      <output data-testid="encryption">{encryption.kind}</output>
      {connection.kind === "error" || connection.kind === "unavailable" ? (
        <output data-testid="message">{connection.message}</output>
      ) : null}
      {connection.kind === "error" ? (
        <output data-testid="has-session">{String(connection.session !== null)}</output>
      ) : null}
      <button onClick={() => void signIn()}>sign-in</button>
      <button onClick={() => void cancelSignIn()}>cancel</button>
      <button onClick={() => void signOut()}>sign-out</button>
      <button onClick={retry}>retry</button>
    </>
  );
}

function mount(active?: boolean) {
  return render(
    <ChatProvider active={active}>
      <Probe />
    </ChatProvider>,
  );
}

const keyMaterial = () => ({
  keyBase64: Buffer.from(OUR_KEY).toString("base64"),
  keyId: OUR_KEY_ID,
  keyName: OUR_KEY_NAME,
});

beforeEach(() => {
  tauri.reset();
  openExternalLink.mockClear();
  clientMock.startChatClient.mockReset();
  clientMock.stopChatClient.mockReset();
  clientMock.signOutChat.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  world = makeWorld({ latency: true });
  clientMock.startChatClient.mockImplementation(async (session: ChatSession) => ({
    client: makeClient(world),
    slidingSync: {},
    ready: Promise.resolve(),
    getSession: () => session,
    dispose: async () => undefined,
  }));
  tauri.onInvoke("chat_derive_secret_storage_key", keyMaterial);
});

afterEach(() => {
  clearSecretStorageKey();
  vi.restoreAllMocks();
});

describe("ChatProvider boot", () => {
  // The provider is mounted for the whole signed-in app (`ChatHost`) and
  // gated by Rust's config through `active`: while the gate is off nothing
  // touches the keyring or the network; when it turns on, boot runs.
  it("does nothing while inactive, then boots when the gate opens", async () => {
    tauri.onInvoke("chat_get_session", () => SESSION);
    const { rerender } = mount(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("connection")).toHaveTextContent("booting");
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("chat_get_session");
    expect(clientMock.startChatClient).not.toHaveBeenCalled();

    rerender(
      <ChatProvider active>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("ready"));
    expect(clientMock.startChatClient).toHaveBeenCalledTimes(1);
  });

  it("with no stored session: signed-out, and nothing is started", async () => {
    tauri.onInvoke("chat_get_session", () => null);
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    expect(clientMock.startChatClient).not.toHaveBeenCalled();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("chat_derive_secret_storage_key");
  });

  // The keyring being unreadable is not "signed out": a sign-in offered
  // here would fail again at the keyring write. Distinct state, retry only.
  it("when the OS credential store is unreadable: 'unavailable', not signed-out", async () => {
    tauri.onInvoke("chat_get_session", () => {
      throw { kind: "Auth", message: "the OS credential store is unavailable: no secret service" };
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("unavailable"));
    expect(screen.getByTestId("message")).toHaveTextContent(/credential store is unavailable/);
    expect(clientMock.startChatClient).not.toHaveBeenCalled();

    // Retry re-reads the keyring; once it answers, boot proceeds.
    tauri.onInvoke("chat_get_session", () => null);
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
  });

  it("when the stored session is corrupt: an error with no session, so sign-in is offered with the reason", async () => {
    tauri.onInvoke("chat_get_session", () => {
      throw { kind: "Auth", message: "stored chat session is unreadable: bad json" };
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("error"));
    expect(screen.getByTestId("has-session")).toHaveTextContent("false");
    expect(screen.getByTestId("message")).toHaveTextContent(/unreadable/);
  });

  it("when the first sync fails: an error that keeps the session, and the client is stopped", async () => {
    tauri.onInvoke("chat_get_session", () => SESSION);
    clientMock.startChatClient.mockImplementation(async (session: ChatSession) => {
      const handle = {
        client: makeClient(world),
        slidingSync: {},
        ready: Promise.reject(new Error("Could not reach the chat server.")),
        getSession: () => session,
        dispose: async () => undefined,
      };
      handle.ready.catch(() => undefined);
      return handle;
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("error"));
    expect(screen.getByTestId("has-session")).toHaveTextContent("true");
    expect(screen.getByTestId("message")).toHaveTextContent(/reach the chat server/);
    expect(clientMock.stopChatClient).toHaveBeenCalledTimes(1);
  });

  it("when the session expires mid-run: the client is stopped, an error keeps the session, and retry lands on sign-in", async () => {
    let stored: ChatSession | null = SESSION;
    tauri.onInvoke("chat_get_session", () => stored);
    let expire: (() => void) | null = null;
    clientMock.startChatClient.mockImplementation(
      async (session: ChatSession, callbacks: { onSessionExpired?: () => void }) => {
        expire = callbacks.onSessionExpired ?? null;
        return {
          client: makeClient(world),
          slidingSync: {},
          ready: Promise.resolve(),
          getSession: () => session,
          dispose: async () => undefined,
        };
      },
    );
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("ready"));
    expect(expire).not.toBeNull();

    // Rust deletes the session before the refresher reports it dead.
    stored = null;
    act(() => expire!());
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("error"));
    expect(screen.getByTestId("message")).toHaveTextContent(/session has expired/);
    expect(screen.getByTestId("has-session")).toHaveTextContent("true");
    expect(clientMock.stopChatClient).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    // The effect cleanup must not stop the already-stopped client twice.
    expect(clientMock.stopChatClient).toHaveBeenCalledTimes(1);
  });
});

describe("ChatProvider encryption bootstrap", () => {
  it("fresh device on an account with published cross-signing but no secret storage: bootstraps with the key Rust derives", async () => {
    // Observed after a first sign-in from another client: `/keys/query`
    // publishes master/self-signing/user-signing, the account has no
    // m.secret_storage.default_key and no m.cross_signing.* secrets, and
    // the new device carries no signature.
    world = makeWorld({
      latency: true,
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
    });
    tauri.onInvoke("chat_get_session", () => SESSION);

    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("ready"));
    await waitFor(() => expect(screen.getByTestId("encryption")).toHaveTextContent(/^ready$/), {
      timeout: 4000,
    });

    // The key came from Rust, once, and was published under Rust's id.
    expect(tauri.core.invoke).toHaveBeenCalledWith("chat_derive_secret_storage_key");
    expect(defaultKeyId(world)).toBe(OUR_KEY_ID);
    expect(world.calls).toContain(`addKey(${OUR_KEY_ID})`);
    // The published identity is unusable (private keys unrecoverable): a
    // fresh set, not an import that can never succeed.
    expect(world.calls).toContain("bootstrapCrossSigning(reset=true)");
    for (const s of [
      "m.cross_signing.master",
      "m.cross_signing.self_signing",
      "m.cross_signing.user_signing",
      "m.megolm_backup.v1",
    ]) {
      expect(secretUnder(world, s, OUR_KEY_ID), s).toBe(true);
    }
    expect(world.published.deviceSigned).toBe(true);
  });

  it("device already complete: reports ready without asking Rust for the key", async () => {
    world = makeWorld({
      latency: true,
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: true },
      crypto: { privateKeysCached: true, heldBackupKeyTag: "k", activeBackupVersion: "1" },
      backupVersion: "1",
      backupKeyTag: "k",
    });
    world.accountData.set("m.secret_storage.default_key", { key: OUR_KEY_ID });
    world.accountData.set("m.cross_signing.master", { encrypted: { [OUR_KEY_ID]: {} } });
    tauri.onInvoke("chat_get_session", () => SESSION);

    mount();
    await waitFor(() => expect(screen.getByTestId("encryption")).toHaveTextContent(/^ready$/), {
      timeout: 4000,
    });
    expect(world.calls.some((c) => c.startsWith("bootstrap"))).toBe(false);
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("chat_derive_secret_storage_key");
  });

  it("when Rust cannot derive the key: encryption error, connection stays ready", async () => {
    world = makeWorld({ latency: true });
    tauri.onInvoke("chat_get_session", () => SESSION);
    tauri.onInvoke("chat_derive_secret_storage_key", () => {
      throw { kind: "Auth", message: "no mnemonic for this account" };
    });

    mount();
    await waitFor(() => expect(screen.getByTestId("encryption")).toHaveTextContent("error"), {
      timeout: 4000,
    });
    expect(screen.getByTestId("connection")).toHaveTextContent("ready");
    expect(world.calls.some((c) => c.startsWith("bootstrap"))).toBe(false);
  });
});

describe("ChatProvider sign-in / sign-out", () => {
  it("sign-in: opens Rust's authorize URL in the system browser, waits on the loopback, then boots the persisted session", async () => {
    let stored: ChatSession | null = null;
    tauri.onInvoke("chat_get_session", () => stored);
    tauri.onInvoke("chat_begin_sign_in", () => ({
      flowId: "flow-1",
      authorizeUrl: "https://auth.example.org/authorize?state=x",
    }));
    let finish: (s: ChatSession) => void = () => undefined;
    tauri.onInvoke(
      "chat_complete_sign_in",
      (args) =>
        new Promise<ChatSession>((resolve) => {
          expect(args).toEqual({ flowId: "flow-1" });
          finish = (s) => {
            stored = s; // Rust persists before answering
            resolve(s);
          };
        }),
    );

    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByText("sign-in"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signing-in"));
    await waitFor(() =>
      expect(openExternalLink).toHaveBeenCalledWith("https://auth.example.org/authorize?state=x"),
    );
    expect(clientMock.startChatClient).not.toHaveBeenCalled();

    await act(async () => finish(SESSION));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("ready"));
    expect(clientMock.startChatClient).toHaveBeenCalledWith(SESSION, expect.anything());
  });

  it("cancel during sign-in: tells Rust to abort the flow and returns to signed-out; a late completion is ignored", async () => {
    tauri.onInvoke("chat_get_session", () => null);
    tauri.onInvoke("chat_begin_sign_in", () => ({ flowId: "flow-2", authorizeUrl: "https://x/" }));
    let reject: (e: unknown) => void = () => undefined;
    tauri.onInvoke(
      "chat_complete_sign_in",
      () =>
        new Promise<ChatSession>((_resolve, rej) => {
          reject = rej;
        }),
    );
    tauri.onInvoke("chat_cancel_sign_in", () => undefined);

    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    fireEvent.click(screen.getByText("sign-in"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signing-in"));

    fireEvent.click(screen.getByText("cancel"));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("chat_cancel_sign_in", { flowId: "flow-2" }),
    );
    expect(screen.getByTestId("connection")).toHaveTextContent("signed-out");

    // Rust's blocked completion now fails (aborted): not surfaced as an error.
    await act(async () => reject({ kind: "Auth", message: "sign-in cancelled" }));
    expect(screen.getByTestId("connection")).toHaveTextContent("signed-out");
  });

  // `chat_begin_sign_in` runs discovery, metadata and client registration
  // over the network before it hands back a flow id. A Cancel click in that
  // window used to be lost: the ref it cleared was still empty, so when
  // begin answered the browser opened anyway and the completed sign-in was
  // taken as live, contradicting the signed-out screen the user was seeing.
  it("cancel before Rust has answered begin: the flow is aborted in Rust when it arrives, and the browser never opens", async () => {
    tauri.onInvoke("chat_get_session", () => null);
    let begun: (flow: { flowId: string; authorizeUrl: string }) => void = () => undefined;
    tauri.onInvoke(
      "chat_begin_sign_in",
      () =>
        new Promise<{ flowId: string; authorizeUrl: string }>((resolve) => {
          begun = resolve;
        }),
    );
    tauri.onInvoke("chat_complete_sign_in", () => {
      throw new Error("must not be waited on for a cancelled attempt");
    });
    tauri.onInvoke("chat_cancel_sign_in", () => undefined);

    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    fireEvent.click(screen.getByText("sign-in"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signing-in"));

    fireEvent.click(screen.getByText("cancel"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    // Nothing to abort yet: no flow id exists.
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("chat_cancel_sign_in", expect.anything());

    await act(async () => begun({ flowId: "flow-late", authorizeUrl: "https://x/" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("chat_cancel_sign_in", { flowId: "flow-late" }),
    );
    expect(openExternalLink).not.toHaveBeenCalled();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("chat_complete_sign_in", expect.anything());
    expect(screen.getByTestId("connection")).toHaveTextContent("signed-out");

    // A new sign-in is possible right away: the cancelled attempt does not
    // hold the "already signing in" guard.
    tauri.onInvoke("chat_begin_sign_in", () => ({ flowId: "flow-next", authorizeUrl: "https://y/" }));
    tauri.onInvoke("chat_complete_sign_in", () => new Promise<ChatSession>(() => undefined));
    fireEvent.click(screen.getByText("sign-in"));
    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith("https://y/"));
  });

  it("a failed sign-in start surfaces as a session-less error (sign-in offered again with the reason)", async () => {
    tauri.onInvoke("chat_get_session", () => null);
    tauri.onInvoke("chat_begin_sign_in", () => {
      throw { kind: "NotReady", message: "Sign in to Hippius first" };
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    fireEvent.click(screen.getByText("sign-in"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("error"));
    expect(screen.getByTestId("has-session")).toHaveTextContent("false");
    expect(screen.getByTestId("message")).toHaveTextContent("Sign in to Hippius first");
    expect(openExternalLink).not.toHaveBeenCalled();
  });

  it("sign-out from ready: stops the client through signOutChat and lands on signed-out", async () => {
    tauri.onInvoke("chat_get_session", () => SESSION);
    mount();
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("ready"));

    fireEvent.click(screen.getByText("sign-out"));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("signed-out"));
    expect(clientMock.signOutChat).toHaveBeenCalledTimes(1);
    const [handle, session] = clientMock.signOutChat.mock.calls[0] as unknown as [
      unknown,
      ChatSession,
    ];
    expect(handle).not.toBeNull();
    expect(session).toEqual(SESSION);
  });
});
