// Sending an emailed invite from a locked app: Rust refuses before anything
// is sent, the app's own unlock comes up, and the send follows a successful
// unlock. A cancelled unlock sends nothing and keeps the address. After a
// send whose key could not be sealed to the recipient at once, an info toast
// says they may need approving.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, configure, render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import { InvitePeopleSection, MAY_NEED_APPROVING } from "../InvitePeopleSection";
import { activeRecoveryCheckAtom, type RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";

// Under a loaded parallel run the default one second is not always enough.
configure({ asyncUtilTimeout: 3000 });

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const emailDriveInviteMock = vi.fn();
const checkInviteEmailMock = vi.fn();
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    emailDriveInvite: (...a: unknown[]) => emailDriveInviteMock(...a),
    emailInvitesAvailable: () => Promise.resolve(true),
    checkInviteEmail: (...a: unknown[]) => checkInviteEmailMock(...a),
  };
});

// The real flow asks Rust which unlock applies and mounts the recovery
// dialog by setting `activeRecoveryCheckAtom`; the dialog clears it when it
// closes. This stands in for that: `unlock` opens the "dialog".
const unlock = vi.hoisted(() => ({ fn: vi.fn(), opensDialog: true }));
const UNLOCK_CHECK: RecoveryCheck = {
  hasServerBlob: true,
  hasLocalMnemonic: false,
  canDecryptLocal: false,
  updatedAt: null,
  recommendedFlow: "unlock",
};
let store: ReturnType<typeof createStore>;
vi.mock("@/app/lib/hooks/useUnlockFlow", () => ({
  useUnlockFlow: () => ({
    unlock: async () => {
      unlock.fn();
      if (unlock.opensDialog) store.set(activeRecoveryCheckAtom, UNLOCK_CHECK);
    },
    busy: false,
    isOAuth: true,
  }),
}));

const LOCKED = { kind: "NotReady", subkind: "NO_ENCRYPTION_KEY", message: "No encryption key available" };

function renderSection() {
  store = createStore();
  const onSent = vi.fn();
  render(
    <Provider store={store}>
      <InvitePeopleSection label="team-docs" pathPrefix={null} onSent={onSent} onUpgrade={() => {}} />
    </Provider>,
  );
  return { onSent };
}

async function typeAndSend(value: string) {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value } });
  await waitFor(() => expect(checkInviteEmailMock).toHaveBeenCalledWith(value));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
}

/** The recovery dialog closes (after an unlock, or a cancel). */
async function closeUnlockDialog() {
  await act(async () => {
    store.set(activeRecoveryCheckAtom, null);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Queued answers never leak from one test into the next.
  emailDriveInviteMock.mockReset();
  unlock.opensDialog = true;
  checkInviteEmailMock.mockResolvedValue({ valid: true });
});

describe("sending an emailed invite from a locked app", () => {
  it("unlocks first, then sends the same invite once", async () => {
    emailDriveInviteMock.mockRejectedValueOnce(LOCKED).mockResolvedValueOnce({ inviteId: "i1", presealed: true });
    const { onSent } = renderSection();

    await typeAndSend("ada@example.com");

    await waitFor(() => expect(unlock.fn).toHaveBeenCalledTimes(1));
    expect(store.get(activeRecoveryCheckAtom)).not.toBeNull();
    expect(onSent).not.toHaveBeenCalled();
    // Locked is not an error to show: the unlock is the answer.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("ada@example.com");

    await closeUnlockDialog();

    await waitFor(() => expect(emailDriveInviteMock).toHaveBeenCalledTimes(2));
    expect(emailDriveInviteMock.mock.calls[1]).toEqual(emailDriveInviteMock.mock.calls[0]);
    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(unlock.fn).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("sends nothing when the unlock is cancelled, and keeps the address", async () => {
    // Cancelled: the session is still locked, so Rust refuses the resumed
    // send before anything goes out.
    emailDriveInviteMock.mockRejectedValue(LOCKED);
    const { onSent } = renderSection();

    await typeAndSend("ada@example.com");
    await waitFor(() => expect(unlock.fn).toHaveBeenCalledTimes(1));
    await closeUnlockDialog();

    await waitFor(() => expect(emailDriveInviteMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(unlock.fn).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email address")).toHaveValue("ada@example.com");
    expect(screen.queryByText(/Invite sent/)).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not send later on its own when no unlock dialog came up", async () => {
    unlock.opensDialog = false;
    emailDriveInviteMock.mockRejectedValue(LOCKED);
    renderSection();

    await typeAndSend("ada@example.com");
    await waitFor(() => expect(unlock.fn).toHaveBeenCalledTimes(1));
    await act(async () => {});

    // An unrelated recovery dialog opening and closing later is not this send's unlock.
    await act(async () => {
      store.set(activeRecoveryCheckAtom, UNLOCK_CHECK);
    });
    await closeUnlockDialog();
    expect(emailDriveInviteMock).toHaveBeenCalledTimes(1);
  });

  it("sends at once, with no unlock, when the app is unlocked", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1", presealed: true });
    renderSection();

    await typeAndSend("ada@example.com");

    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
    expect(unlock.fn).not.toHaveBeenCalled();
    expect(emailDriveInviteMock).toHaveBeenCalledTimes(1);
  });
});

describe("after the send", () => {
  it("says they may need approving when the key could not be sealed to them", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1", presealed: false });
    renderSection();

    await typeAndSend("ada@example.com");

    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(MAY_NEED_APPROVING);
    expect(MAY_NEED_APPROVING).toBe("They may need approving when they open it.");
  });

  it("says nothing more when the key went up sealed", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1", presealed: true });
    renderSection();

    await typeAndSend("ada@example.com");

    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
    expect(toast.info).not.toHaveBeenCalled();
  });
});
