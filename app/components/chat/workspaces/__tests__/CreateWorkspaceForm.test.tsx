import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";

const createWorkspace = vi.fn();
vi.mock("@/lib/chat/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/spaces")>()),
  createWorkspace: (...args: unknown[]) => createWorkspace(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: CreateWorkspaceForm, addChannelSlug } = await import("@/components/chat/workspaces/CreateWorkspaceForm");

const client = { getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;

describe("addChannelSlug", () => {
  it("slugifies, dedupes and ignores blanks", () => {
    expect(addChannelSlug(["general"], "Product Design")).toEqual(["general", "product-design"]);
    expect(addChannelSlug(["general"], "General")).toEqual(["general"]);
    expect(addChannelSlug(["general"], "  ")).toEqual(["general"]);
  });
});

describe("CreateWorkspaceForm", () => {
  beforeEach(() => createWorkspace.mockReset());

  it("starts with #general and #random, lets you edit them, and creates with every channel as default", async () => {
    createWorkspace.mockResolvedValue({ spaceId: "!s", channelIds: ["!g", "!d"] });
    const onCreated = vi.fn();
    render(<CreateWorkspaceForm client={client} onCreated={onCreated} />);

    expect(screen.getByRole("button", { name: "Remove #general" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove #random" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create workspace/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Acme Corp" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove #random" }));
    fireEvent.change(screen.getByLabelText("Add a channel"), { target: { value: "Design" } });
    fireEvent.keyDown(screen.getByLabelText("Add a channel"), { key: "Enter", code: "Enter" });
    expect(screen.getByRole("button", { name: "Remove #design" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(createWorkspace).toHaveBeenCalledTimes(1);
    const [, options] = createWorkspace.mock.calls[0] as [unknown, { name: string; channels: { name: string; isDefault: boolean }[] }];
    expect(options.name).toBe("Acme Corp");
    expect(options.channels).toEqual([
      { name: "general", isDefault: true },
      { name: "design", isDefault: true },
    ]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ spaceId: "!s", channelIds: ["!g", "!d"] }, "Acme Corp"));
  });

  it("never lets the last channel go", async () => {
    render(<CreateWorkspaceForm client={client} onCreated={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove #random" }));
    expect(screen.getByRole("button", { name: "Remove #general" })).toBeDisabled();
  });
});
