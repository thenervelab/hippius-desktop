"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

import TicketsTable from "./TicketsTable";
import CreateTicketModal, {
  CreateTicketData,
  CreateTicketModalRef,
} from "./CreateTicketModal";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import TicketMessagesDialog from "./TicketMessagesDialog";
import type {
  SupportTicket as SupportTicketType,
  TicketMessage,
} from "@/app/lib/hooks/useSupportTickets";
import { RefreshButton, SearchInput } from "../../ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { LogoMark } from "@/components/ui/LogoMark";
import useCreateSupportTicket from "@/app/lib/hooks/useCreateSupportTicket";
import useUploadTicketAttachment from "@/app/lib/hooks/useUploadTicketAttachment";
import useSupportTickets, {
  SupportTicket,
} from "@/app/lib/hooks/useSupportTickets";
import useUpdateSupportTicket from "@/app/lib/hooks/useUpdateSupportTicket";
import CreateButton from "../../ui/button/CreateButton";
import ConfirmModal from "./SupportConfirmModal";
import { OAuthButtonsGroup } from "../../auth/OAuthButtons";

type DevTableMode = "real" | "loading" | "mock" | "empty";

const Support: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const createTicketModalRef = useRef<CreateTicketModalRef>(null);

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
  const [isMessagesDialogOpen, setIsMessagesDialogOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(
    null
  );
  const [ticketToClose, setTicketToClose] = useState<SupportTicket | null>(
    null
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Dev-only state — lets us iterate on every screen without needing real
  // tickets or a non-mnemonic account. Stripped at build time when
  // NODE_ENV === "production" since `isDev` short-circuits all dev UI.
  const isDev = process.env.NODE_ENV !== "production";
  const [devBypassGate, setDevBypassGate] = useState(false);
  const [devTableMode, setDevTableMode] = useState<DevTableMode>("real");
  const [isDevMockOpen, setIsDevMockOpen] = useState(false);

  // Debounce search term with 500ms delay
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Reset to first page when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm]);

  const { data, isLoading, error, refetch, isRefetching } = useSupportTickets({
    page: currentPage,
    limit: pageSize,
    search: debouncedSearchTerm,
  });

  const { mutate: createTicket } = useCreateSupportTicket({
    onSuccess: () => {
      // Don't show success here, will be shown after attachment upload if needed
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create ticket");
    },
  });

  const { mutateAsync: uploadAttachment } = useUploadTicketAttachment();

  const { mutate: updateTicket, isPending: isUpdating } =
    useUpdateSupportTicket({
      onSuccess: () => {
        toast.success("Ticket closed successfully!");
        setIsCloseModalOpen(false);
        setTicketToClose(null);
        refetch();
      },
      onError: (error) => {
        toast.error(error.message || "Failed to close ticket");
      },
    });

  // Sort tickets by status: open > in progress > closed > resolved
  const sortedTickets = useMemo(() => {
    if (!data?.results) return [];

    const statusOrder: { [key: string]: number } = {
      open: 0,
      in_progress: 1,
      closed: 2,
      resolved: 3,
    };

    return [...data.results].sort((a, b) => {
      const statusA = statusOrder[a.status.toLowerCase()] ?? 999;
      const statusB = statusOrder[b.status.toLowerCase()] ?? 999;
      return statusA - statusB;
    });
  }, [data?.results]);

  const totalCount = data?.count ?? 0;
  const totalPages = useMemo(
    () => (totalCount ? Math.ceil(totalCount / pageSize) : 1),
    [totalCount, pageSize]
  );

  const handleCreateTicket = () => {
    setIsModalOpen(true);
  };

  const handleSubmitTicket = async (ticketData: CreateTicketData) => {
    const { attachment, ...ticketPayload } = ticketData;

    setIsSubmitting(true);

    // If no attachment, just create the ticket normally
    if (!attachment) {
      createTicket(
        {
          ...ticketPayload,
          resource_type: "",
          resource_id: "",
        },
        {
          onSuccess: () => {
            setIsSubmitting(false);
            setIsModalOpen(false);
            createTicketModalRef.current?.resetForm();
            toast.success("Ticket created successfully!");
            refetch();
          },
          onError: () => {
            setIsSubmitting(false);
          },
        }
      );
      return;
    }

    // If there's an attachment, create ticket first, keep modal open, then upload attachment
    createTicket(
      {
        ...ticketPayload,
        resource_type: "",
        resource_id: "",
      },
      {
        onSuccess: async (ticket) => {
          try {
            if (ticket.messages && ticket.messages.length > 0) {
              await uploadAttachment({
                ticket_id: ticket.id.toString(),
                message_id: ticket.messages[0].id.toString(),
                filePath: attachment.path,
                filename: attachment.name,
              });
            } else {
              throw new Error("No message ID available in ticket response");
            }

            setIsSubmitting(false);
            setIsModalOpen(false);
            createTicketModalRef.current?.resetForm();
            toast.success("Ticket created successfully!");
            refetch();
          } catch (error) {
            setIsSubmitting(false);
            setIsModalOpen(false);
            createTicketModalRef.current?.resetForm();
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to upload attachment"
            );
            refetch();
          }
        },
        onError: (error) => {
          setIsSubmitting(false);
          toast.error(error.message || "Failed to create ticket");
        },
      }
    );
  };

  const handleRefresh = () => {
    refetch();
  };

  const handleViewMessages = (ticket: SupportTicket) => {
    setSelectedTicket(ticket);
    setIsMessagesDialogOpen(true);
  };

  const handleCloseTicket = (ticket: SupportTicket) => {
    setTicketToClose(ticket);
    setIsCloseModalOpen(true);
  };

  const handleConfirmCloseTicket = () => {
    if (ticketToClose) {
      updateTicket({
        id: ticketToClose.id,
        status: "closed",
      });
    }
  };

  const handleCancelCloseTicket = () => {
    setIsCloseModalOpen(false);
    setTicketToClose(null);
  };

  const handleCloseMessagesDialog = () => {
    setIsMessagesDialogOpen(false);
    setSelectedTicket(null);
  };

  // Check if user is logged in with mnemonic (access key)
  const isAccessKeyLogin = oauthSession?.provider === "mnemonic";
  const showGate = isAccessKeyLogin && !(isDev && devBypassGate);

  // ── Dev overrides applied to the table ──────────────────────────────
  // Mock and empty modes substitute the data array entirely. Loading mode
  // forces the skeleton path. Error path is suppressed when any dev mode
  // is active so the user can still see the table chrome above the body.
  const useDevTableOverride = isDev && devTableMode !== "real";
  const tableData = !useDevTableOverride
    ? sortedTickets
    : devTableMode === "mock"
      ? MOCK_TICKETS_LIST
      : [];
  const tableIsLoading =
    isDev && devTableMode === "loading" ? true : isLoading;
  const tableIsError = useDevTableOverride ? false : !!error;
  const tableTotalCount = !useDevTableOverride
    ? totalCount
    : devTableMode === "mock"
      ? MOCK_TICKETS_LIST.length
      : 0;
  const tableTotalPages = !useDevTableOverride
    ? totalPages
    : Math.max(1, Math.ceil(tableTotalCount / pageSize));

  return (
    <>
      {showGate ? (
        <AccessKeyLoginGate />
      ) : (
        <div className="flex flex-col px-4 pb-6 w-full">
          {/* Page header — title + info tooltip on the left, New Ticket on the right */}
          <div className="flex items-center justify-between gap-3 mt-3 px-1">
            <div className="flex items-center gap-2">
              <p className="text-[24px] font-medium leading-8 text-black-700 dark:text-white">
                My Tickets
              </p>
              <TooltipPrimitive.Provider delayDuration={300}>
                <TooltipPrimitive.Root>
                  <TooltipPrimitive.Trigger asChild>
                    <button
                      type="button"
                      aria-label="About support tickets"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400 dark:hover:bg-black-300 dark:hover:text-white"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipPrimitive.Trigger>
                  <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                      side="bottom"
                      align="start"
                      sideOffset={8}
                      avoidCollisions
                      collisionPadding={8}
                      className="z-[9999] max-w-[280px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
                    >
                      View and manage your support tickets. Click &ldquo;New
                      Ticket&rdquo; to start a conversation with our support
                      team.
                      <TooltipPrimitive.Arrow className="fill-white dark:fill-[#2c2c2c]" />
                    </TooltipPrimitive.Content>
                  </TooltipPrimitive.Portal>
                </TooltipPrimitive.Root>
              </TooltipPrimitive.Provider>
            </div>

            <CreateButton
              text="+ New Ticket"
              isLoading={false}
              onClick={handleCreateTicket}
            />
          </div>

          {/* Tickets card — outer ring with search/refresh header, inner table */}
          <div className="mt-6 flex flex-col items-center w-full rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
            <div className="flex h-[46px] w-full items-center justify-end gap-2 pl-[14px] pr-[10px]">
              <div className="w-[207px]">
                <SearchInput
                  value={searchTerm}
                  onChange={(value: string) => setSearchTerm(value)}
                  placeholder="Search Global"
                />
              </div>
              <RefreshButton
                refetching={isRefetching}
                onClick={handleRefresh}
                ariaLabel="Refresh tickets"
              />
            </div>

            <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
              <TicketsTable
                data={tableData}
                isLoading={tableIsLoading}
                isError={tableIsError}
                isRefreshing={isRefetching}
                currentPage={currentPage}
                totalPages={tableTotalPages}
                totalCount={tableTotalCount}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setCurrentPage(1);
                }}
                onViewMessages={handleViewMessages}
                onCloseTicket={handleCloseTicket}
                onCreateTicket={handleCreateTicket}
              />
            </div>
          </div>
        </div>
      )}

      {/* Create Ticket Modal */}
      <CreateTicketModal
        ref={createTicketModalRef}
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleSubmitTicket}
        isLoading={isSubmitting}
      />

      {/* Close Ticket Confirmation Modal */}
      <ConfirmModal
        open={isCloseModalOpen}
        title="Close Ticket"
        description={
          <div className="max-w-[20.25rem] w-full text-center mx-auto">
            Are you sure you want to close ticket{" "}
            <strong>{ticketToClose?.subject}</strong>? This action is permanent
          </div>
        }
        loading={isUpdating}
        onConfirm={handleConfirmCloseTicket}
        onCancel={handleCancelCloseTicket}
        variant="close"
        confirmText={isUpdating ? "Closing..." : "Close Ticket"}
        cancelText="Cancel"
      />

      {/* Ticket Messages Dialog */}
      <TicketMessagesDialog
        open={isMessagesDialogOpen}
        onClose={handleCloseMessagesDialog}
        ticket={selectedTicket}
        onCloseTicket={handleCloseTicket}
      />

      {/* Dev-only mocked dialog — separate instance so it can't collide
          with a real ticket the user just opened. Renders a hard-coded
          ticket + message history matching the Figma sample. */}
      {isDev && (
        <TicketMessagesDialog
          open={isDevMockOpen}
          onClose={() => setIsDevMockOpen(false)}
          ticket={MOCK_TICKET}
          mockMessages={MOCK_MESSAGES}
          mockIsLoading={false}
        />
      )}

      {/* Floating dev tools — bottom-left so it doesn't collide with the
          bottom-right ticket messages dialog. Stripped at build time when
          NODE_ENV === "production". */}
      {isDev && (
        <DevToolsPanel
          bypassGate={devBypassGate}
          onToggleBypassGate={setDevBypassGate}
          tableMode={devTableMode}
          onChangeTableMode={setDevTableMode}
          onOpenCreateTicket={() => setIsModalOpen(true)}
          onOpenMessagesDialog={() => setIsDevMockOpen(true)}
        />
      )}
    </>
  );
};

export default Support;

// ─── Dev preview fixtures ───────────────────────────────────────────────
// Used by the "Preview Ticket Dialog" button (dev only). Mirrors the
// Figma sample exactly so the rendered preview is a 1:1 reference. Kept
// inline rather than in a separate fixtures file because they are tightly
// coupled to the preview button's wiring above.

const MOCK_TICKET: SupportTicketType = {
  id: -999,
  subject: "Hippius Test Ticket",
  status: "open",
  priority: "medium",
  category: "billing",
  resource_type: "",
  resource_id: "",
  created_by: 0,
  assigned_to: null,
  created_at: "2021-03-03T10:48:00.000Z",
  updated_at: "2021-03-03T10:48:00.000Z",
  closed_at: null,
};

// Seven rows mirroring the Figma table sample — covers every status,
// every priority, both billing/general categories, and the date format
// used in the design. The IDs are negative so a (future) real ticket
// won't collide if someone clicks "View Messages" on a mock row.
const MOCK_TICKETS_LIST: SupportTicketType[] = [
  {
    id: -1001,
    subject: "Hippius Test Ticket",
    status: "resolved",
    priority: "medium",
    category: "billing",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1002,
    subject: "Hippius Test New",
    status: "open",
    priority: "low",
    category: "billing",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1003,
    subject: "Hippius Test New and Final",
    status: "resolved",
    priority: "high",
    category: "general",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1004,
    subject: "Hippius Test New and real FInal",
    status: "open",
    priority: "low",
    category: "billing",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1005,
    subject: "Test 1",
    status: "resolved",
    priority: "medium",
    category: "billing",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1006,
    subject: "Hippius Test New and real FInal",
    status: "resolved",
    priority: "medium",
    category: "general",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
  {
    id: -1007,
    subject: "Test 2",
    status: "resolved",
    priority: "high",
    category: "general",
    resource_type: "",
    resource_id: "",
    created_by: 0,
    assigned_to: null,
    created_at: "2021-08-03T20:01:00.000Z",
    updated_at: "2021-08-03T20:01:00.000Z",
    closed_at: null,
  },
];

const MOCK_MESSAGES: TicketMessage[] = [
  {
    id: -1,
    author: 1,
    author_is_staff: false,
    author_is_requester: true,
    author_display: "Test User",
    message_type: "public",
    body: "This is a test ticket, but also I have like zero credits. How can Dubs get me some please?",
    created_at: "2021-03-03T10:48:00.000Z",
    attachments: [],
  },
  {
    id: -2,
    author: 2,
    author_is_staff: true,
    author_is_requester: false,
    author_display: "Dubs",
    message_type: "public",
    body: "Hey Dubs here, thank you for bringing it to our notice. I owe you 30 credits",
    created_at: "2021-03-03T10:48:00.000Z",
    attachments: [],
  },
];

// Pre-computed diagonal SVG textures used for the corner backdrops
// around the login card. Lifted from NoEntriesBackgroundContainer so
// the visual matches the rest of the framed-dialog surfaces (and the
// hippius-web VM beta-access state that inspired this design).
const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

// Access-key login gate.
//
// Renders the BackgroundContainer "framed dialog" frame (matching the Figma
// blue-bordered card) with the Sign In to Hippius card content inside —
// minus the Access Key button, since the user is *already* on access-key
// and needs to switch to an OAuth provider to access tickets.
const AccessKeyLoginGate: React.FC = () => {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(""));
  }, []);

  return (
    <div className="flex flex-1 w-full items-center justify-center px-4 py-6 overflow-hidden">
      <div className="relative">
        {/* Diagonal-texture backdrop tiles sitting OUTSIDE the dialog
            at the top-left and bottom-right corners. Each tile is
            sized w-full h-full of the card and shifted via right-full
            bottom-full (top-left) / left-full top-full (bottom-right)
            so the diagonal stripes flow out of those two corners —
            matching the hippius-web VM beta-access pattern. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-full h-full bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-full h-full bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-full h-full bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-full h-full bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />

      <BackgroundContainer
        className="relative w-full max-w-[613px]"
        fillClassName="fill-[#f9f9f9] dark:fill-[#202020]"
        strokeClassName="stroke-[#b3b3b3] dark:stroke-[#6c6c6c]"
        contentClassName="flex justify-center"
        shellClassName="w-full min-w-0 max-w-[613px]"
        cardClassName="w-full min-w-0 max-w-full p-[min(1rem,16px)] gap-[min(0.75rem,12px)] items-center"
      >
        <LogoMark />

        <h1 className="w-full text-center text-grey-10 dark:text-grey-light-100 font-medium text-[min(1.75rem,28px)] leading-[min(2.25rem,36px)] tracking-[-0.03em]">
          Log In to Hippius
        </h1>

        <p className="self-stretch text-center text-grey-50 dark:text-grey-dark-600 font-medium text-[16px] leading-[22px] tracking-[-0.32px]">
          Support tickets are not available with Access Key login. Please sign
          in with one of the following providers to access this feature.
        </p>

        <div className="flex flex-col gap-[min(1rem,16px)] items-center w-full">
          <OAuthButtonsGroup onAccessKeyClick={() => {}} hideAccessKey />

          <div className="h-px w-full bg-grey-80 dark:bg-[#494949]" />

          <p className="w-full text-center text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-800 font-medium">
            By continuing you agree to our
            <br />
            <button
              type="button"
              onClick={() =>
                openUrl("https://hippius.com/terms-and-conditions")
              }
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Terms and Conditions
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openUrl("https://hippius.com/privacy-policy")}
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Privacy Policy
            </button>
          </p>

          {version && (
            <p className="text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-600 font-medium">
              Version {version}
            </p>
          )}
        </div>
      </BackgroundContainer>
      </div>
    </div>
  );
};

// ─── Dev Tools Panel ────────────────────────────────────────────────────
// Floating bottom-left control surface for previewing every support
// screen without real data. Section 1 toggles the access-key gate so we
// can render the table page on any account. Section 2 swaps the table
// body between four states. Section 3 opens the Create Ticket dialog and
// the mocked Ticket Messages dialog directly. Hidden in production.

interface DevToolsPanelProps {
  bypassGate: boolean;
  onToggleBypassGate: (next: boolean) => void;
  tableMode: DevTableMode;
  onChangeTableMode: (mode: DevTableMode) => void;
  onOpenCreateTicket: () => void;
  onOpenMessagesDialog: () => void;
}

const TABLE_MODE_OPTIONS: { value: DevTableMode; label: string }[] = [
  { value: "real", label: "Real data" },
  { value: "loading", label: "Loading" },
  { value: "mock", label: "Mock tickets (7)" },
  { value: "empty", label: "Empty state" },
];

const DevToolsPanel: React.FC<DevToolsPanelProps> = ({
  bypassGate,
  onToggleBypassGate,
  tableMode,
  onChangeTableMode,
  onOpenCreateTicket,
  onOpenMessagesDialog,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="fixed bottom-4 left-4 z-[10010] flex w-[228px] flex-col gap-2 rounded-[10px] border border-dashed border-[#9333ea]/50 bg-white p-3 text-grey-10 shadow-[0_12px_32px_-12px_rgba(147,51,234,0.35)] dark:border-[#a855f7]/40 dark:bg-[#1a1a1f] dark:text-grey-light-100 dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
      role="region"
      aria-label="Support dev tools"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9333ea] dark:text-[#c084fc]">
          Dev Tools
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-[10px] font-medium uppercase tracking-[0.08em] text-grey-50 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:text-white"
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-3">
          {/* Section: Page state */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-grey-50 dark:text-grey-dark-700">
              Page
            </p>
            <label className="flex items-center gap-2 text-[12px] font-medium text-grey-dark-800 dark:text-grey-dark-400">
              <input
                type="checkbox"
                checked={bypassGate}
                onChange={(e) => onToggleBypassGate(e.target.checked)}
                className="size-3.5 accent-[#9333ea]"
              />
              Bypass Access Key gate
            </label>
          </div>

          {/* Section: Table state */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-grey-50 dark:text-grey-dark-700">
              Table state
            </p>
            <div className="flex flex-col gap-1">
              {TABLE_MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 text-[12px] font-medium text-grey-dark-800 dark:text-grey-dark-400"
                >
                  <input
                    type="radio"
                    name="dev-table-mode"
                    value={opt.value}
                    checked={tableMode === opt.value}
                    onChange={() => onChangeTableMode(opt.value)}
                    className="size-3.5 accent-[#9333ea]"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Section: Open dialogs */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-grey-50 dark:text-grey-dark-700">
              Open dialogs
            </p>
            <button
              type="button"
              onClick={onOpenCreateTicket}
              className="flex h-7 w-full items-center justify-center rounded-[6px] border border-grey-80 bg-grey-light-300 px-2 text-[12px] font-medium text-grey-10 transition-colors hover:bg-grey-90 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]"
            >
              Create Ticket dialog
            </button>
            <button
              type="button"
              onClick={onOpenMessagesDialog}
              className="flex h-7 w-full items-center justify-center rounded-[6px] border border-grey-80 bg-grey-light-300 px-2 text-[12px] font-medium text-grey-10 transition-colors hover:bg-grey-90 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]"
            >
              Messages dialog (mock)
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
