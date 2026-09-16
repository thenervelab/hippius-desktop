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
