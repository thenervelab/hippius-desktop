// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MemberRow, OwnerRow, PendingRow } from "../PeopleWithAccessSection";
import { HolderRow, LinkRow } from "../../access-panel/AccessPanelRows";
import type { AccessPanelHolder, AccessPanelLink, DriveInviteInfo } from "@/app/lib/tauri/sharedDrives";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Every place a person is named in the Share dialog and the Manage access
// panel shortens the name, address or email in the MIDDLE (`MiddleTruncate`)
// and never with CSS `truncate`, which cut the end: "5DSQAMf3JVb3V…5… (you)"
// was a shortened address cut again at its end, and an email lost its domain.

const OWNER = "5DSQAMf3JVb3VqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqK7x5Wd";
const OTHER = "5CV9U636UM4LJqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqLjc3M";
const EMAIL = "julien.du.bois@starkleytech.com";

/** No element from `el` up to the row ellipsizes at the end. */
function expectNoEndTruncate(el: Element, root: Element) {
  for (let node: Element | null = el; node && node !== root.parentElement; node = node.parentElement) {
    expect(node.className.toString()).not.toMatch(/(^|\s)(truncate|text-ellipsis)(\s|$)/);
  }
}

/** The middle-shortened line that carries `text`. */
function lineFor(root: HTMLElement, text: string): HTMLElement {
  const line = [...root.querySelectorAll<HTMLElement>("[data-middle-truncate]")].find(
    (el) => el.querySelector("[data-text]")?.getAttribute("data-text") === text,
  );
  expect(line, `a middle-shortened line for ${text}`).toBeDefined();
  return line!;
}

describe("people rows name everyone without an end cut", () => {
  it("owner row: the whole address, shortened in the middle, and (you) outside it", () => {
    const { container } = render(<OwnerRow ss58={OWNER} isYou />);
    const line = lineFor(container, OWNER);
    expectNoEndTruncate(line, container);
    const you = screen.getByText("(you)");
    expect(line.contains(you)).toBe(false);
    // (you) never gives way: the address does.
    expect(you.className).toMatch(/\bshrink-0\b/);
    expect(line.textContent).not.toContain("(you)");
  });

  it("member row: the email keeps its domain in a middle-shortened line", () => {
    const { container } = render(
      <MemberRow
        member={{ memberSs58: OTHER, role: "reader", memberName: "Julien Du Bois", memberEmail: EMAIL, isYou: false }}
        readOnly
        onChangeRole={() => {}}
        onRemove={() => {}}
      />,
    );
    expectNoEndTruncate(lineFor(container, "Julien Du Bois"), container);
    const email = lineFor(container, EMAIL);
    expectNoEndTruncate(email, container);
    expect(email.getAttribute("title")).toBe(EMAIL);
  });

  it("pending invite: the address is shortened in the middle", () => {
    const invite: DriveInviteInfo = {
      inviteId: "i1",
      role: "reader",
      mintedBy: OWNER,
      expiresAt: "",
      maxUses: 1,
      useCount: 0,
      revoked: false,
      valid: true,
      createdAt: "",
      recipientEmail: EMAIL,
      emailStatus: "sent",
    };
    const { container } = render(<PendingRow invite={invite} onCancel={() => {}} />);
    expectNoEndTruncate(lineFor(container, EMAIL), container);
  });

  it("folder holder in the panel: name, email and (you) with no end cut", () => {
    const holder: AccessPanelHolder = {
      memberSs58: OTHER,
      memberEmail: EMAIL,
      isYou: true,
      role: "reader",
      pathPrefix: "Clients",
      folders: ["Clients"],
    };
    const { container } = render(<HolderRow holder={holder} canManage onRemove={() => {}} />);
    expectNoEndTruncate(lineFor(container, OTHER), container);
    expectNoEndTruncate(lineFor(container, EMAIL), container);
    const you = screen.getByText("(you)");
    expect(lineFor(container, OTHER).contains(you)).toBe(false);
  });

  it("link row: 'by' and the whole creator address, never a pre-shortened one", () => {
    const link: AccessPanelLink = {
      inviteId: "l1",
      role: "writer",
      mintedBy: OTHER,
      mintedByYou: false,
      useCount: 0,
      maxUses: 5,
      singleUse: false,
      usagePercent: 0,
      status: "active",
      expiresAt: "",
      neverExpires: true,
      expiresInSecs: null,
      linkAvailable: false,
    };
    const { container } = render(
      <LinkRow link={link} locked={false} unlocking={false} onUnlock={() => {}} onRevoke={() => {}} />,
    );
    const creator = lineFor(container, OTHER);
    expectNoEndTruncate(creator, container);
    expect(creator.parentElement?.textContent).toContain(" · by ");
    expect(container.textContent).not.toMatch(/…\S*…/);
  });
});
