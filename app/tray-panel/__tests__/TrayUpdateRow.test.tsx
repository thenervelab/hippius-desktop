import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import TrayUpdateRow from "@/app/tray-panel/TrayUpdateRow";

// The popover's "Update available" row: present only when Rust found a
// version, and one click opens the update in the main window.
describe("TrayUpdateRow", () => {
  it("shows nothing when there is no update", () => {
    const { container } = render(<TrayUpdateRow version={null} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the version and opens the update on click", () => {
    const onOpen = vi.fn();
    render(<TrayUpdateRow version="0.6.30" onOpen={onOpen} />);
    expect(screen.getByText("Hippius 0.6.30 is ready to install")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tray-update-row"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
