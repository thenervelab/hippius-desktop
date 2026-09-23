// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Pagination } from "@/components/ui/table";

/**
 * A `<select>` whose `value` matches no `<option>` does not warn, throw, or
 * render empty — it displays the FIRST option. So a table paging by a size
 * outside the option list reports a size it is not using, and picking the
 * size it was already claiming reads as a control that does nothing.
 *
 * The Drive table pages by 15 against options of 10/25/50/100, which is
 * exactly that: fifteen rows under a control reading "10/PAGE".
 */
describe("Pagination page-size control", () => {
  const renderPager = (pageSize: number) =>
    render(
      <Pagination
        currentPage={1}
        totalPages={3}
        setPage={vi.fn()}
        pageSize={pageSize}
        setPageSize={vi.fn()}
      />,
    );

  it("offers the size it is actually paging by, even outside the option list", () => {
    renderPager(15);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("15");
    expect(
      screen.getByRole("option", { name: "15/PAGE" }),
    ).toBeInTheDocument();
  });

  it("keeps the standard options and orders the added one among them", () => {
    renderPager(15);

    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());
    expect(labels).toEqual([
      "10/PAGE",
      "15/PAGE",
      "25/PAGE",
      "50/PAGE",
      "100/PAGE",
    ]);
  });

  it("keeps the starting size selectable after the user switches away", () => {
    // The Drive browse table opens at 20, which is not a preset. Picking 25
    // used to recompute the 20 option away, stranding the user on the presets
    // with no route back to the size the table opened on.
    const { rerender } = renderPager(20);
    expect(screen.getByRole("option", { name: "20/PAGE" })).toBeInTheDocument();

    rerender(
      <Pagination
        currentPage={1}
        totalPages={3}
        setPage={vi.fn()}
        pageSize={25}
        setPageSize={vi.fn()}
      />,
    );

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("25");
    expect(
      screen.getByRole("option", { name: "20/PAGE" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("option").map((o) => o.textContent?.trim()),
    ).toEqual(["10/PAGE", "20/PAGE", "25/PAGE", "50/PAGE", "100/PAGE"]);
  });

  it("adds nothing when the size is already an option", () => {
    renderPager(25);

    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());
    expect(labels).toEqual(["10/PAGE", "25/PAGE", "50/PAGE", "100/PAGE"]);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("25");
  });
});

/**
 * The open list is drawn by the OS. It takes its colours from `color-scheme`
 * and from the select's own background and text — a `dark:` class on an
 * `<option>` is not enough on its own. Left at the light default it painted a
 * white popup and inherited translucent white text, so in dark mode the
 * closed control read correctly and every option in the open list was
 * invisible.
 */
describe("Pagination page-size control in dark mode", () => {
  const renderPager = () =>
    render(
      <Pagination
        currentPage={1}
        totalPages={3}
        setPage={vi.fn()}
        pageSize={50}
        setPageSize={vi.fn()}
      />,
    );

  it("asks the OS for a dark popup", () => {
    renderPager();
    expect(screen.getByRole("combobox").className).toContain("dark:[color-scheme:dark]");
  });

  it("gives the control an opaque dark background, not a translucent one", () => {
    renderPager();
    const className = screen.getByRole("combobox").className;
    expect(className).toContain("dark:bg-black-500");
    // `dark:bg-white/[0.02]` is what the popup inherited and painted over white.
    expect(className).not.toMatch(/dark:bg-white\//);
  });

  it("colours every option for both themes rather than inheriting", () => {
    renderPager();
    for (const option of screen.getAllByRole("option")) {
      expect(option.className).toContain("dark:text-");
      expect(option.className).toContain("dark:bg-");
    }
  });
});

/**
 * On a single page the row exists for the size control alone — a reader who
 * chose 50 must be able to get back to 20 even where everything fits. The
 * page buttons are not part of that: an arrow that can never be enabled and a
 * lone "1" are controls with nothing to do.
 */
describe("Pagination on a single page", () => {
  const renderPager = (totalPages: number) =>
    render(
      <Pagination
        currentPage={1}
        totalPages={totalPages}
        setPage={vi.fn()}
        totalCount={40}
        pageSize={50}
        setPageSize={vi.fn()}
      />,
    );

  it("drops the page buttons", () => {
    renderPager(1);
    expect(screen.queryByRole("button", { name: "1" })).not.toBeInTheDocument();
  });

  it("keeps the size control and the range label", () => {
    renderPager(1);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getAllByText("1-40 OUT OF 40").length).toBeGreaterThan(0);
  });

  it("still draws the buttons once there is a second page", () => {
    renderPager(2);
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });
});
