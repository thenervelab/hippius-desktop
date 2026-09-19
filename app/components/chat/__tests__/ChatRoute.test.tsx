import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";

import ChatRoute from "@/components/chat/ChatRoute";
import type { ChatConnection, ChatContextValue } from "@/components/chat/ChatProvider";
import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import type { ChatConfig } from "@/app/lib/tauri/chat";

/**
 * The route's two jobs: gate on Rust's runtime config, and map each
 * provider state to the one screen the user should see. The provider is
 * replaced by a stub so each connection state can be rendered directly.
 */

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/chat",
}));

let connection: ChatConnection = { kind: "signed-out" };
const stub = () =>
  ({
    connection,
    encryption: { kind: "unknown" },
    syncState: null,
    signIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    retry: vi.fn(),
    unlockEncryption: vi.fn(),
    repairEncryption: vi.fn(),
    client: null,
  }) satisfies ChatContextValue;

vi.mock("@/components/chat/ChatProvider", () => ({
  ChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useChat: () => stub(),
}));

const CONFIG: ChatConfig = {
  enabled: true,
  serverName: "hippius.com",
  fallbackBaseUrl: "https://chat.hippius.com",
  communitySpaceAlias: "#hippius:hippius.com",
  secretStorageKeyId: "hippius-console-v1",
  secretStorageKeyName: "Hippius Console recovery key",
  apiBaseUrl: "https://api.hippius.com",
};

function mount(config: ChatConfig | null) {
  const store = createStore();
  store.set(chatConfigAtom, config);
  return render(
    <JotaiProvider store={store}>
      <ChatRoute />
    </JotaiProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  connection = { kind: "signed-out" };
});

describe("ChatRoute gate", () => {
  it("renders nothing and does not redirect while the config is unknown", () => {
    const { container } = mount(null);
    expect(container).toBeEmptyDOMElement();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to the overview once Rust reports chat disabled", async () => {
    const { container } = mount({ ...CONFIG, enabled: false });
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("renders the chat when enabled", () => {
    mount(CONFIG);
    expect(screen.getByText("Open team chat")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("ChatRoute screens", () => {
  it("signing-in: says to finish in the browser and offers Cancel, not a second sign-in", () => {
    connection = { kind: "signing-in" };
    mount(CONFIG);
    expect(screen.getByRole("status")).toHaveTextContent(/browser/i);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.queryByText("Open team chat")).toBeNull();
  });

  // The keyring cannot be read: a sign-in would fail again at the keyring
  // write, so the only affordance is Retry.
  it("unavailable: shows the reason and Retry only — no sign-in, no sign-out", () => {
    connection = { kind: "unavailable", message: "the OS credential store is unavailable: x" };
    mount(CONFIG);
    expect(screen.getByRole("alert")).toHaveTextContent(/credential store is unavailable/);
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText("Open team chat")).toBeNull();
    expect(screen.queryByText("Sign out of chat")).toBeNull();
  });

  it("error without a session (sign-in failed): the signed-out screen with the reason", () => {
    connection = { kind: "error", message: "Sign in to Hippius first", session: null };
    mount(CONFIG);
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in to Hippius first");
    expect(screen.getByText("Open team chat")).toBeInTheDocument();
  });

  it("error with a session (boot failed): Retry and Sign out of chat", () => {
    connection = {
      kind: "error",
      message: "Could not reach the chat server.",
      session: {
        baseUrl: "https://chat.hippius.com",
        issuer: "https://chat.hippius.com/",
        clientId: "c",
        userId: "@a:hippius.com",
        deviceId: "D",
        accessToken: "t",
        storeLayout: "device",
      },
    };
    mount(CONFIG);
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Sign out of chat")).toBeInTheDocument();
    expect(screen.queryByText("Open team chat")).toBeNull();
  });
});
