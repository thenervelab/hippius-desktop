import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { MnemonicField } from "../_shared";

describe("MnemonicField", () => {
  it("uses the shared Input shell, not a one-off textarea", () => {
    render(
      <MnemonicField
        label="Mnemonic Seed"
        value=""
        onChange={() => {}}
        placeholder="Enter or paste your 12-word seed phrase"
      />
    );

    const field = screen.getByPlaceholderText(/12-word seed phrase/i);
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
        label="Mnemonic Seed"
        value="wrong words"
        onChange={() => {}}
        errorMessage="This recovery phrase does not match this account's files."
        placeholder="Enter or paste your 12-word seed phrase"
      />
    );

    const field = screen.getByPlaceholderText(/12-word seed phrase/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.parentElement?.className).toContain("border-error-70");
    const error = screen.getByText(/does not match this account's files/i);
    expect(error.className).toContain("text-error-60");
  });

  it("forwards typed text through onChange", () => {
    const onChange = vi.fn();
    render(
      <MnemonicField
        label="Mnemonic Seed"
        value=""
        onChange={onChange}
        placeholder="Enter or paste your 12-word seed phrase"
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/12-word seed phrase/i), {
      target: { value: "abandon abandon abandon" },
    });
    expect(onChange).toHaveBeenCalledWith("abandon abandon abandon");
  });
});
