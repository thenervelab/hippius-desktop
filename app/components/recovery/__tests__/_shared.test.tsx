import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { MnemonicField, PasswordField, seedWordsFor } from "../_shared";

describe("MnemonicField", () => {
  it("uses the shared Input shell, not a one-off textarea", () => {
    render(
      <MnemonicField
        label="Recovery Seed"
        value=""
        onChange={() => {}}
        placeholder="Enter or paste your 12-word recovery seed"
      />
    );

    const field = screen.getByPlaceholderText(/12-word recovery seed/i);
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.className).toContain("resize-none");
    expect(field.parentElement?.className).toContain("rounded-[8px]");
    expect(field.parentElement?.className).toContain("dark:border-[#494949]");
    expect(field.parentElement?.className).toContain("dark:bg-[#1f1f1f]");
    expect(field.parentElement?.className).not.toContain("rounded-md");
  });

  it("paints the Input invalid ring and error-60 copy on error", () => {
    render(
      <MnemonicField
        label="Recovery Seed"
        value="wrong words"
        onChange={() => {}}
        errorMessage="These words don't match this account's files."
        placeholder="Enter or paste your 12-word recovery seed"
      />
    );

    const field = screen.getByPlaceholderText(/12-word recovery seed/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.parentElement?.className).toContain("border-error-70");
    const error = screen.getByText(/don't match this account's files/i);
    expect(error.className).toContain("text-error-60");
    expect(error).toHaveAttribute("role", "alert");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(screen.getByLabelText("Recovery Seed")).toBe(field);
  });

  it("forwards typed text through onChange", () => {
    const onChange = vi.fn();
    render(
      <MnemonicField
        label="Recovery Seed"
        value=""
        onChange={onChange}
        placeholder="Enter or paste your 12-word recovery seed"
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/12-word recovery seed/i), {
      target: { value: "abandon abandon abandon" },
    });
    expect(onChange).toHaveBeenCalledWith("abandon abandon abandon");
  });
});

describe("PasswordField", () => {
  it("is labelled by its label alone, not by its error text", () => {
    render(
      <PasswordField
        label="Unlock Password"
        value="x"
        onChange={() => {}}
        errorMessage="Wrong password. Try again."
      />
    );
    const field = screen.getByLabelText("Unlock Password");
    expect(field.tagName).toBe("INPUT");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Wrong password. Try again.");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("has no error wiring while there is no error", () => {
    render(<PasswordField label="Unlock Password" value="" onChange={() => {}} />);
    const field = screen.getByLabelText("Unlock Password");
    expect(field).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops the Caps Lock note when the field loses focus", () => {
    render(<PasswordField label="Unlock Password" value="" onChange={() => {}} />);
    const field = screen.getByLabelText("Unlock Password");
    fireEvent.keyDown(field, { key: "A", modifierCapsLock: true });
    expect(screen.getByText("Caps Lock is on.")).toBeInTheDocument();
    fireEvent.blur(field);
    expect(screen.queryByText("Caps Lock is on.")).not.toBeInTheDocument();
  });
});

describe("seedWordsFor", () => {
  it("calls the words an access key for accounts that sign in with them", () => {
    expect(seedWordsFor("mnemonic")).toMatchObject({ name: "access key", title: "Access Key" });
  });

  it("calls them a recovery seed for everyone else", () => {
    for (const auth of ["oauth", null, undefined] as const) {
      expect(seedWordsFor(auth)).toMatchObject({ name: "recovery seed", title: "Recovery Seed" });
    }
  });
});
