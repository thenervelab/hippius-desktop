"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";

import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import TicketsTable from "./TicketsTable";
import { P } from "@/components/ui/typography";
import CreateTicketModal, {
  CreateTicketData,
  CreateTicketModalRef,
} from "./CreateTicketModal";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import TicketMessagesDialog from "./TicketMessagesDialog";
import Lock from "../../ui/icons/Lock";
import { Ticket } from "../../ui/icons";
import { RefreshButton, SearchInput } from "../../ui";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import useCreateSupportTicket from "@/app/lib/hooks/useCreateSupportTicket";
import useUploadTicketAttachment from "@/app/lib/hooks/useUploadTicketAttachment";
import useSupportTickets, {
  SupportTicket,
} from "@/app/lib/hooks/useSupportTickets";
import useUpdateSupportTicket from "@/app/lib/hooks/useUpdateSupportTicket";
import CreateButton from "../../ui/button/CreateButton";
import ConfirmModal from "./SupportConfirmModal";
import { OAuthButtonsGroup } from "../../auth/OAuthButtons";

const SUPPORT_DOCS_URL = "https://docs.hippius.com/use/help-support";

const Support: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const createTicketModalRef = useRef<CreateTicketModalRef>(null);

  const [pageSize] = useState(10);
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

  const { mutate: createTicket, isPending: isCreating } =
    useCreateSupportTicket({
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
  const filteredTickets = useMemo(() => {
    if (!data?.results) return [];

    const statusOrder: { [key: string]: number } = {
      open: 0,
      "in progress": 1,
      closed: 2,
      resolved: 3,
    };

    return data.results.sort((a, b) => {
      const statusA = statusOrder[a.status.toLowerCase()] ?? 999;
      const statusB = statusOrder[b.status.toLowerCase()] ?? 999;
      return statusA - statusB;
    });
  }, [data?.results]);

  // Calculate total pages based on API response
  const totalPages = useMemo(() => {
    if (!data?.count) return 1;
    return Math.ceil(data.count / pageSize);
  }, [data?.count, pageSize]);

  const handleCreateTicket = () => {
    setIsModalOpen(true);
  };

  const handleSubmitTicket = async (ticketData: CreateTicketData) => {
    const { attachment, ...ticketPayload } = ticketData;

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
            toast.success("Ticket created successfully!");
            setIsModalOpen(false);
            createTicketModalRef.current?.resetForm();
            setTimeout(() => refetch(), 0);
          },
        }
      );
      return;
    }

    // If there's an attachment, create ticket then upload attachment
    try {
      // Step 1: Create the ticket (returns ticket with messages array)
      createTicket(
        {
          ...ticketPayload,
          resource_type: "",
          resource_id: "",
        },
        {
          onSuccess: async (ticket) => {
            // Close modal immediately for better UX
            setIsModalOpen(false);
            createTicketModalRef.current?.resetForm();
            toast.success("Ticket created successfully!");

            try {
              // Step 2: Upload the attachment using the first message ID from the response
              if (ticket.messages && ticket.messages.length > 0) {
                await uploadAttachment({
                  ticket_id: ticket.id.toString(),
                  message_id: ticket.messages[0].id.toString(),
                  file: attachment,
                });

                // Refetch in background after attachment upload
                setTimeout(() => refetch(), 0);
              } else {
                throw new Error("No message ID available in ticket response");
              }
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Failed to upload attachment"
              );
              // Still refetch even if attachment fails
              setTimeout(() => refetch(), 0);
            }
          },
          onError: (error) => {
            toast.error(error.message || "Failed to create ticket");
          },
        }
      );
    } catch {
      toast.error("An unexpected error occurred");
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
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

  return (
    <div className="w-full">
      {/* Access Key Login Overlay */}
      {isAccessKeyLogin ? (
        <div className="flex items-center justify-center min-h-[37.5rem]">
          <div className="max-w-md w-full px-4 py-6 bg-white rounded-lg shadow-lg border border-grey-80">
            <div className="text-center mb-4 w-[20.625rem] mx-auto">
              <AbstractIconWrapper className="size-12 mx-auto mb-4 flex items-center justify-center">
                <Lock className="size-7 relative text-primary-50" />
              </AbstractIconWrapper>
              <h3 className="text-2xl font-medium text-grey-10 mb-2">
                Login Required
              </h3>
              <p className="text-base text-grey-50">
                Support tickets are not available with Access Key login. Please
                sign in with one of the following providers to access this
                feature.
              </p>
            </div>

            <OAuthButtonsGroup
              onAccessKeyClick={() => {}}
              hideAccessKey={true}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Header & Controls */}
          <div className="flex items-center w-full justify-between gap-4 flex-wrap mb-5">
            <div className="flex items-center justify-between w-full sm:w-auto">
              <div className="flex items-center gap-x-2">
                <AbstractIconWrapper className="size-10 flex items-center justify-center">
                  <Ticket className="size-6 relative text-primary-50" />
                </AbstractIconWrapper>
                <P size="lg">My Tickets</P>
                <button
                  onClick={() => openUrl(SUPPORT_DOCS_URL)}
                  aria-label="Support documentation"
                  title="Support documentation"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50"
                >
                  <HelpCircle className="size-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-x-4">
              <SearchInput
                placeholder="Search for a ticket"
                className="h-9"
                value={searchTerm}
                onChange={(e: string) => setSearchTerm(e)}
              />
              <RefreshButton
                refetching={isRefetching}
                onClick={handleRefresh}
              />

              {!isAccessKeyLogin && (
                <CreateButton
                  text="New Ticket"
                  isLoading={false}
                  onClick={handleCreateTicket}
                />
              )}
            </div>
          </div>

          {/* Tickets Table */}
          <TicketsTable
            data={filteredTickets}
            isLoading={isLoading}
            isError={!!error}
            isRefreshing={isRefetching}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            onViewMessages={handleViewMessages}
            onCloseTicket={handleCloseTicket}
          />

          {/* Create Ticket Modal */}
          <CreateTicketModal
            ref={createTicketModalRef}
            open={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            onSubmit={handleSubmitTicket}
            isLoading={isCreating}
          />

          {/* Close Ticket Confirmation Modal */}
          <ConfirmModal
            open={isCloseModalOpen}
            title="Close Ticket"
            description={
              <div className="w-[20.25rem] text-center mx-auto">
                Are you sure you want to close ticket{" "}
                <strong>{ticketToClose?.subject}</strong>? This action is
                permanent
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
        </>
      )}
    </div>
  );
};

export default Support;
