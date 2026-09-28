// The value a dialog-style `Select` holds must read as normal text in light
// mode. It used to take `text-grey-dark-800` (#7d7d7d), the same grey as the
// placeholder, so a chosen role or expiry ("Editor", "7 days") looked
// disabled on a white dialog while dark mode showed it white. jsdom does not
// paint, so the pin is the class list: the trigger carries the normal text
// colour for both themes, keeps the muted grey for the placeholder only, and
// a disabled select still dims as a whole.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SELECT_VALUE_TEXT, Select } from "@/components/ui/select/Select";

const OPTIONS = [
  { label: "Viewer", value: "reader" },
  { label: "Editor", value: "writer" },
];

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

describe("Select value colour", () => {
  it("shows a chosen value in the normal text colour in light mode, white in dark", () => {
    render(<Select ariaLabel="Role" value="writer" onValueChange={vi.fn()} options={OPTIONS} size="compact" />);
    const trigger = screen.getByLabelText("Role");
    expect(trigger).toHaveTextContent("Editor");
    const classes = classesOf(trigger);
    expect(SELECT_VALUE_TEXT).toBe("text-grey-10 dark:text-white");
    expect(classes).toEqual(expect.arrayContaining(["text-grey-10", "dark:text-white"]));
    // The placeholder grey applies only while there is no value.
    expect(classes).not.toContain("text-grey-dark-800");
    expect(classes).toContain("data-[placeholder]:text-grey-dark-800");
  });

  it("keeps the same colour for a quiet select in a list row", () => {
    render(
      <Select ariaLabel="Role for Ann" value="writer" onValueChange={vi.fn()} options={OPTIONS} size="compact" chrome="quiet" minimal />,
    );
    const classes = classesOf(screen.getByLabelText("Role for Ann"));
    expect(classes).toEqual(expect.arrayContaining(["text-grey-10", "dark:text-white"]));
  });

  it("still dims a genuinely disabled select", () => {
    render(<Select ariaLabel="Role" value="writer" onValueChange={vi.fn()} options={OPTIONS} disabled />);
    const trigger = screen.getByLabelText("Role");
    expect(trigger).toBeDisabled();
    expect(classesOf(trigger)).toContain("disabled:opacity-60");
  });

  it("keeps the placeholder muted", () => {
    render(<Select ariaLabel="Role" onValueChange={vi.fn()} options={OPTIONS} placeholder="Pick a role" />);
    const trigger = screen.getByLabelText("Role");
    expect(trigger).toHaveAttribute("data-placeholder");
    expect(classesOf(trigger)).toContain("dark:data-[placeholder]:text-[#7d7d7d]");
  });
});
