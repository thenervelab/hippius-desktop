// Regression pin for the shared dialog-style `Select` used inside
// `FramedDialog` (the drive-invite "Invite expires" and file-share
// "Link expires" pickers).
//
// The Select portals its dropdown to <body>, so it does not inherit the
// dialog's stacking context — it competes with FramedDialog's own portalled
// layers. It shipped at z-[60] while the dialog's FULL-SCREEN
// `Dialog.Content` positioner is z-[61], so the dropdown painted behind the
// dialog's opaque card: Radix opened it (the trigger chevron even flipped)
// but nothing was visible and the value appeared stuck on its default.
//
// jsdom does not paint, so the pin is the stacking order itself: whatever
// carries the dropdown must outrank the dialog layer it is portalled
// alongside. Comparing the two live elements (rather than asserting a
// literal z-[100]) keeps the test meaningful if either layer is restyled.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Select } from "@/components/ui/select/Select";

const OPTIONS = [
  { label: "24 hours", value: "86400" },
  { label: "7 days", value: "604800" },
  { label: "Never expires", value: "3153600000" },
];

/** Nearest `z-[N]` on the element or one of its ancestors, as a number. */
function stackingOrder(start: Element | null): number | null {
  for (let el: Element | null = start; el; el = el.parentElement) {
    const match = /(?:^|\s)z-\[(\d+)\]/.exec(el.getAttribute("class") ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

function openSelectInDialog() {
  render(
    <FramedDialog open onClose={vi.fn()} title="Share drive" icon={<span />}>
      <Select
        ariaLabel="Invite expires"
        value="604800"
        onValueChange={vi.fn()}
        options={OPTIONS}
      />
    </FramedDialog>,
  );
  // Radix opens its select trigger on Enter/Space/Arrow keys.
  fireEvent.keyDown(screen.getByLabelText("Invite expires"), { key: "Enter" });
}

describe("Select inside FramedDialog", () => {
  it("mounts every option when opened", () => {
    openSelectInDialog();

    // "7 days" is the selected value and so also renders inside the trigger;
    // the other two exist only in the dropdown.
    expect(screen.getByText("24 hours")).toBeInTheDocument();
    expect(screen.getByText("Never expires")).toBeInTheDocument();
  });

  it("stacks the dropdown above the dialog instead of behind its card", () => {
    openSelectInDialog();

    const dialogZ = stackingOrder(document.querySelector('[role="dialog"]'));
    const dropdownZ = stackingOrder(screen.getByText("Never expires"));

    expect(dialogZ).not.toBeNull();
    expect(dropdownZ).not.toBeNull();
    expect(dropdownZ as number).toBeGreaterThan(dialogZ as number);
  });
});
