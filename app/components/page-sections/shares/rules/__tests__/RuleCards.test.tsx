import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { RuleCards, type LinkRule } from "../RuleCards";

const RULES: LinkRule[] = [
  { id: "gate", label: "Ask for email", on: true, value: "Code by email", editor: <p>gate editor</p> },
  { id: "watermark", label: "Watermark", on: false, value: "PDFs only" },
];

describe("rule cards", () => {
  it("shows each rule's label, On or Off and value in one column", () => {
    render(<RuleCards rules={RULES} />);
    const gate = screen.getByTestId("rule-gate");
    expect(gate).toHaveTextContent("Ask for email");
    expect(gate).toHaveTextContent("Code by email");
    expect(gate).toHaveTextContent("On");
    expect(screen.getByTestId("rule-watermark")).toHaveTextContent("Off");
  });

  it("a read-only rule is not a button", () => {
    render(<RuleCards rules={RULES} />);
    expect(within(screen.getByTestId("rule-watermark")).queryByRole("button")).toBeNull();
  });

  it("pushes a rule's editor in place of the cards, and Back returns focus to its card", async () => {
    const onPushedChange = vi.fn();
    render(<RuleCards rules={RULES} onPushedChange={onPushedChange} />);
    fireEvent.click(within(screen.getByTestId("rule-gate")).getByRole("button"));
    expect(screen.getByText("gate editor")).toBeInTheDocument();
    expect(screen.queryByTestId("rule-cards")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ask for email" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toHaveFocus());
    expect(onPushedChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("gate editor")).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId("rule-gate")).getByRole("button")).toHaveFocus());
    expect(onPushedChange).toHaveBeenLastCalledWith(false);
  });

  it("goes back to the cards when the open rule goes away", () => {
    const { rerender } = render(<RuleCards rules={RULES} />);
    fireEvent.click(within(screen.getByTestId("rule-gate")).getByRole("button"));
    rerender(<RuleCards rules={RULES.slice(1)} />);
    expect(screen.getByTestId("rule-cards")).toBeInTheDocument();
  });
});
