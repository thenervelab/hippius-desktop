"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

import { X, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import StatusBadge from "./StatusBadge";
import TicketMessageComponent from "./TicketMessage";
import { getSeverityColor } from "./TicketsTable";
import {
  SupportTicket,
  TicketMessage,
} from "@/app/lib/hooks/useSupportTickets";
import useSupportTicketMessages from "@/app/lib/hooks/useSupportTicketMessages";
import usePostTicketMessage from "@/app/lib/hooks/usePostTicketMessage";
import useUploadTicketAttachment from "@/app/lib/hooks/useUploadTicketAttachment";
import { Graphsheet } from "../../ui";
import { TickSquare } from "../../ui/icons";
import AttachSqaure from "../../ui/icons/AttachSquare";
import SendMessage from "../../ui/icons/SendMessage";
import { selectFile } from "@/app/lib/utils/tauri";

interface TicketMessagesDialogProps {
  open: boolean;
  onClose: () => void;
  ticket: SupportTicket | null;
  onCloseTicket?: (ticket: SupportTicket) => void;
}

const TicketMessagesDialog: React.FC<TicketMessagesDialogProps> = ({
  open,
  onClose,
  ticket,
  onCloseTicket,
}) => {
  const [messageText, setMessageText] = useState("");
  const [page] = useState(1);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const messagesContainerRef = React.useRef<HTMLDivElement>(null);

  const {
    data: messagesData,
    isLoading,
    isFetching,
    refetch,
  } = useSupportTicketMessages(
    {
      ticket_id: ticket?.id || 0,
      page,
      limit: 500,
    },
    {
      enabled: !!ticket?.id && open,
    }
  );

  const { mutateAsync: postMessage, isPending: isPosting } =
    usePostTicketMessage();

  const { mutateAsync: uploadAttachment } = useUploadTicketAttachment();

  const formatSeverity = (severity: string) => {
    return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
  };

  const messages = messagesData?.results || [];

  // Track previous ticket ID to detect ticket changes
  const prevTicketIdRef = React.useRef<number | null>(null);
  const isTicketChanged = ticket?.id !== prevTicketIdRef.current;

  React.useEffect(() => {
    if (ticket?.id) {
      prevTicketIdRef.current = ticket.id;
    }
  }, [ticket?.id]);

  // Scroll to bottom when messages load or change
  React.useEffect(() => {
    if (messages.length > 0 && !isLoading) {
      scrollToBottom();
    }
  }, [messages.length, isLoading]);

  // Scroll to bottom when dialog opens
  React.useEffect(() => {
    if (open && messages.length > 0) {
      setTimeout(() => {
        scrollToBottom();
      }, 150);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop =
            messagesContainerRef.current.scrollHeight;
        }
      });
    }
  };

  const handleSendMessage = async () => {
    if (!messageText.trim() || !ticket) return;

    const currentText = messageText.trim();
    const currentAttachments = [...attachments];

    // Clear input immediately for better UX
    setMessageText("");
    setAttachments([]);

    try {
      // Step 1: Post the message to get message ID
      const newMessage = await postMessage({
        ticket_id: ticket.id.toString(),
        message_type: "public",
        body: currentText,
      });

      // Step 2: Upload attachments if any
      if (currentAttachments.length > 0 && newMessage?.id) {
        setIsUploadingAttachments(true);

        try {
          // Upload each attachment separately
          await Promise.all(
            currentAttachments.map((file) =>
              uploadAttachment({
                ticket_id: ticket.id.toString(),
                message_id: newMessage.id.toString(),
                file,
              })
            )
          );
        } catch (uploadError) {
          toast.error(
            uploadError instanceof Error
              ? uploadError.message
              : "Failed to upload some attachments"
          );
        } finally {
          setIsUploadingAttachments(false);
        }
      }

      toast.success("Message sent successfully!");

      // Refetch messages to get the new message
      await refetch();

      // Scroll to bottom after messages are loaded with a slight delay
      setTimeout(() => {
        scrollToBottom();
      }, 50);
    } catch (error) {
      // Restore message and attachments on error
      setMessageText(currentText);
      setAttachments(currentAttachments);
      toast.error(
        error instanceof Error ? error.message : "Failed to send message"
      );
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData.items;
    const files: File[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      setAttachments((prev) => [...prev, ...files]);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAttachClick = async () => {
    const files = await selectFile(true, false);
    if (files && files.length > 0) {
      setAttachments((prev) => [...prev, ...files]);
    }
  };

  const handleCloseTicketClick = () => {
    if (ticket && onCloseTicket) {
      onCloseTicket(ticket);
      onClose();
    }
  };

  const handleRefresh = async () => {
    await refetch();
    setTimeout(() => {
      scrollToBottom();
    }, 0);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0  z-[10000]" />
        <Dialog.Content
          className={cn(
            "fixed right-4 max-h-[min(31.25rem,calc(100vh-5rem))] bottom-4 h-full bg-white shadow-xl z-[10001] border border-grey-80 rounded",
            "flex flex-col",
            "max-sm:left-4 max-sm:right-4 max-sm:w-auto",
            "sm:w-[25rem]"
          )}
        >
          {/* Header */}
          <div className="flex-shrink-0">
            <div className="h-[3.125rem] px-4 flex items-center justify-between border-b border-grey-80 relative">
              <Graphsheet
                majorCell={{
                  lineColor: [213, 224, 248, 1],
                  lineWidth: 1,
                  cellDim: 100,
                }}
                minorCell={{
                  lineColor: [213, 224, 248, 1],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full opacity-50 inset-0"
              />
              <Dialog.Title className="text-base font-medium text-grey-10 relative z-10">
                {ticket?.subject || "Ticket Details"}
              </Dialog.Title>
              <div className="flex items-center gap-2 relative z-10">
                <button
                  onClick={handleRefresh}
                  disabled={isFetching}
                  className="text-grey-60 hover:text-grey-10 focus transition-colors relative disabled:opacity-50 focus-visible:outline-none"
                  title="Refresh messages"
                >
                  <RefreshCw
                    className={cn("size-4", isFetching && "animate-spin")}
                  />
                </button>
                <div className="h-4 w-px bg-grey-80" />
                <button
                  onClick={onClose}
                  className="text-grey-60 hover:text-grey-10  focus transition-colors relative focus-visible:outline-none"
                >
                  <X className="size-5 focus:outline-none" />
                </button>
              </div>
            </div>

            {/* Close Ticket Banner */}
            {ticket?.status !== "closed" && (
              <div className="h-[1.625rem] px-4 flex items-center justify-between bg-grey-100 border-b border-grey-80">
                <span className="text-xs text-grey-60">
                  Has this ticket been resolved?
                </span>
                <button
                  onClick={handleCloseTicketClick}
                  className="flex items-center gap-1 text-xs text-grey-60 hover:text-primary-50 transition-colors"
                >
                  <TickSquare className="size-4 " />
                  <span className="text-grey-10">Close Ticket</span>
                </button>
              </div>
            )}
          </div>

          {/* Messages Content */}
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto px-4 py-6 space-y-4"
          >
            {isLoading || isTicketChanged || isFetching ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="size-6 animate-spin text-primary-50" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-grey-60">No messages yet</p>
              </div>
            ) : (
              messages.map((message: TicketMessage, index: number) => {
                const isStaff = message.author_is_staff;
                const isFirstMessage = index === 0;

                return (
                  <div key={message.id}>
                    {/* First message with status and priority header */}
                    {isFirstMessage && ticket ? (
                      <div className="flex flex-col border border-grey-80 rounded-lg bg-white overflow-hidden justify-end w-fit ml-auto">
                        {/* Status and Priority Row */}
                        <div className="flex items-center gap-2 px-2 py-2 border-b border-grey-80">
                          <StatusBadge textVersion status={ticket.status} />
                          <div className="size-2 rounded bg-grey-90 shrink-0" />
                          <span
                            className={cn(
                              "text-xs font-medium",
                              getSeverityColor(ticket.priority)
                            )}
                          >
                            {formatSeverity(ticket.priority)}
                          </span>
                        </div>
                        {/* First Message Content */}
                        <div className="p-2">
                          <TicketMessageComponent
                            message={message}
                            isFirstMessage={true}
                          />
                        </div>
                      </div>
                    ) : (
                      /* Regular Message */
                      <div
                        className={cn(
                          "flex",
                          isStaff ? "justify-start" : "justify-end"
                        )}
                      >
                        <TicketMessageComponent message={message} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer - Message Input */}
          <div className="flex-shrink-0 border-t border-grey-80">
            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div className="px-2 py-2 flex flex-wrap gap-2 border-b border-grey-80 bg-grey-95">
                {attachments.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-2 py-1 bg-white border border-grey-80 rounded text-xs group hover:border-grey-60 transition-colors"
                  >
                    <span className="text-grey-10 truncate max-w-[9.375rem]">
                      {file.name}
                    </span>
                    <button
                      onClick={() => handleRemoveAttachment(index)}
                      disabled={isPosting || isUploadingAttachments}
                      className="text-grey-60 hover:text-red-500 transition-colors disabled:opacity-50"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input Area */}
            <div className="h-[3.5rem] px-2 py-2.5">
              <div className="h-[2.25rem] flex items-center gap-2 px-2 bg-grey-100 rounded-lg border border-grey-80">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Start typing"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  disabled={
                    isPosting ||
                    isUploadingAttachments ||
                    ticket?.status === "closed"
                  }
                  className="flex-1 bg-transparent text-sm text-grey-10 placeholder:text-grey-60 outline-none disabled:opacity-50"
                />
                <button
                  onClick={handleAttachClick}
                  className="text-grey-60 hover:text-grey-10 transition-colors disabled:opacity-50"
                  disabled={
                    isPosting ||
                    isUploadingAttachments ||
                    ticket?.status === "closed"
                  }
                >
                  <AttachSqaure className="size-4" />
                </button>
                <button
                  onClick={handleSendMessage}
                  disabled={
                    !messageText.trim() ||
                    isPosting ||
                    isUploadingAttachments ||
                    ticket?.status === "closed"
                  }
                  className="text-grey-50 hover:text-primary-40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPosting || isUploadingAttachments ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <SendMessage className="size-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default TicketMessagesDialog;
