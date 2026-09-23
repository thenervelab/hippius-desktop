import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

import CategorySection from "@/components/chat/CategorySection";
import { useCollapsedCategories } from "@/components/chat/hooks/useCollapsedCategories";

describe("CategorySection", () => {
  it("shows its rows when open, hides them and rolls the unread up onto the header when folded", async () => {
    let collapsed = false;
    const view = () => (
      <CategorySection id="!eng" name="Eng" collapsed={collapsed} onToggle={() => undefined} highlight={2} unread={7}>
        <div>#backend</div>
      </CategorySection>
    );
    const { rerender } = render(view());
    expect(screen.getByText("#backend")).toBeVisible();
    expect(screen.queryByLabelText("2 mentions")).toBeNull();
    expect(screen.getByRole("button", { name: /Eng/ })).toHaveAttribute("aria-expanded", "true");

    collapsed = true;
    rerender(view());
    expect(screen.getByText("#backend")).not.toBeVisible();
    expect(screen.getByLabelText("2 mentions")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /Eng/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a plain dot for unread without mentions, and the admin's add button", async () => {
    let added = 0;
    render(
      <CategorySection id="!eng" name="Eng" collapsed highlight={0} unread={3} onToggle={() => undefined} onAdd={() => added++}>
        <div />
      </CategorySection>,
    );
    expect(screen.getByLabelText("3 unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New channel in Eng" }));
    expect(added).toBe(1);
  });
});

describe("useCollapsedCategories", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers folded categories per account and workspace across mounts", () => {
    const first = renderHook(() => useCollapsedCategories("@me:hippius.com", "!acme"));
    expect(first.result.current.isCollapsed("!eng")).toBe(false);
    act(() => first.result.current.toggle("!eng"));
    expect(first.result.current.isCollapsed("!eng")).toBe(true);
    first.unmount();

    const again = renderHook(() => useCollapsedCategories("@me:hippius.com", "!acme"));
    expect(again.result.current.isCollapsed("!eng")).toBe(true);
    const other = renderHook(() => useCollapsedCategories("@me:hippius.com", "!other"));
    expect(other.result.current.isCollapsed("!eng")).toBe(false);

    act(() => again.result.current.toggle("!eng"));
    expect(again.result.current.isCollapsed("!eng")).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it("switches sets when the workspace changes", () => {
    window.localStorage.setItem("hippius-chat-collapsed-categories:@me:hippius.com:!b", JSON.stringify(["!x"]));
    const hook = renderHook(({ spaceId }: { spaceId: string | null }) => useCollapsedCategories("@me:hippius.com", spaceId), {
      initialProps: { spaceId: "!a" },
    });
    expect(hook.result.current.isCollapsed("!x")).toBe(false);
    hook.rerender({ spaceId: "!b" });
    expect(hook.result.current.isCollapsed("!x")).toBe(true);
  });
});
