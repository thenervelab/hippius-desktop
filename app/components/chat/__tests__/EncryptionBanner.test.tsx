import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import EncryptionBanner from "@/components/chat/EncryptionBanner";

describe("EncryptionBanner", () => {
  it("is silent when encryption is ready, even with an unreadable backup (Preferences handles that)", () => {
    const { container } = render(
      <EncryptionBanner
        encryption={{ kind: "ready", warnings: [], backup: { version: "1", readable: false }, restoredKeys: 0 }}
        onUnlock={vi.fn()}
        onRepair={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("foreign key with the signing keys on this device: offers to adopt the Hippius key", () => {
    const onRepair = vi.fn();
    render(
      <EncryptionBanner
        encryption={{ kind: "foreign-key", keyId: "ELEMENT", keyName: "Element", canAdopt: true }}
        onUnlock={vi.fn()}
        onRepair={onRepair}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("set up in another app (Element)");
    fireEvent.click(screen.getByRole("button", { name: "Use my Hippius key" }));
    expect(onRepair).toHaveBeenCalledWith("adopt-derived-key");
  });

  it("foreign key without the signing keys: no one-click action, points at Preferences", () => {
    render(
      <EncryptionBanner
        encryption={{ kind: "foreign-key", keyId: "ELEMENT", canAdopt: false }}
        onUnlock={vi.fn()}
        onRepair={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Preferences › Encryption/);
  });

  it("device-unsigned with the signing key here: 'Verify this device' re-runs the bootstrap", () => {
    const onUnlock = vi.fn();
    render(
      <EncryptionBanner
        encryption={{
          kind: "device-unsigned",
          selfSigningKeyAvailable: true,
          detail: "Could not sign this device: fetch failed",
          warnings: [],
          backup: { version: "1", readable: true },
          restoredKeys: 0,
        }}
        onUnlock={onUnlock}
        onRepair={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("not verified yet");
    fireEvent.click(screen.getByRole("button", { name: "Verify this device" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("device-unsigned without the signing key: instructs to verify from another device, keeps a retry", () => {
    const onUnlock = vi.fn();
    render(
      <EncryptionBanner
        encryption={{
          kind: "device-unsigned",
          selfSigningKeyAvailable: false,
          detail: "The self-signing private key is not on this device.",
          warnings: [],
          backup: { version: null, readable: false },
          restoredKeys: 0,
        }}
        onUnlock={onUnlock}
        onRepair={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/from one of your other devices/);
    expect(screen.queryByRole("button", { name: "Verify this device" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("error: shows the message and offers to run the bootstrap again", () => {
    const onUnlock = vi.fn();
    render(
      <EncryptionBanner
        encryption={{ kind: "error", message: "Cross-signing keys were not published to the server" }}
        onUnlock={onUnlock}
        onRepair={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Cross-signing keys were not published");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});
