"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CheckCircle2,
  Loader2,
  MinusCircle,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import TicketMessageComponent from "./TicketMessage";
import {
  SupportTicket,
  TicketMessage,
} from "@/app/lib/hooks/useSupportTickets";
import useSupportTicketMessages from "@/app/lib/hooks/useSupportTicketMessages";
import usePostTicketMessage from "@/app/lib/hooks/usePostTicketMessage";
import useUploadTicketAttachment from "@/app/lib/hooks/useUploadTicketAttachment";
import { Refresh3, LinkChain } from "@/components/ui/icons";
import SendMessage from "@/components/ui/icons/SendMessage";
import { selectFilePath } from "@/app/lib/utils/tauri";

interface TicketMessagesDialogProps {
  open: boolean;
  onClose: () => void;
  ticket: SupportTicket | null;
  onCloseTicket?: (ticket: SupportTicket) => void;
}

const PRIORITY_COLOR: Record<string, string> = {
  low: "text-grey-60 dark:text-grey-dark-500",
  medium: "text-warning-50 dark:text-[#FEB101]",
  normal: "text-warning-50 dark:text-[#FEB101]",
  high: "text-error-50 dark:text-[#FC7D73]",
  urgent: "text-error-40 dark:text-[#FB4337]",
};

const getSeverityColor = (priority: string): string =>
  PRIORITY_COLOR[priority?.toLowerCase?.()] ??
  "text-grey-60 dark:text-grey-dark-500";

const formatSeverity = (severity: string): string =>
  severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();

type InlineStatusConfig = {
  label: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  iconClassName: string;
  textClassName: string;
};

const getInlineStatus = (status: string): InlineStatusConfig => {
  const normalizedStatus = status.toLowerCase().replace(/\s+/g, "_");

  switch (normalizedStatus) {
    case "resolved":
      return {
        label: "Resolved",
        Icon: CheckCircle2,
        iconClassName: "text-success-60",
        textClassName: "text-black-700 dark:text-grey-dark-500",
      };
    case "in_progress":
      return {
        label: "In Progress",
        Icon: Loader2,
        iconClassName: "text-primary-50",
        textClassName: "text-black-700 dark:text-grey-dark-500",
      };
    case "closed":
      return {
        label: "Closed",
        Icon: XCircle,
        iconClassName: "text-grey-60",
        textClassName: "text-black-700 dark:text-grey-dark-500",
      };
    case "open":
    default:
      return {
        label: "Pending",
        Icon: MinusCircle,
        iconClassName: "text-grey-60",
        textClassName: "text-black-700 dark:text-grey-dark-500",
      };
  }
};

const TicketMessagesDialog: React.FC<TicketMessagesDialogProps> = ({
  open,
  onClose,
  ticket,
}) => {
  const [messageText, setMessageText] = useState("");
  const [attachments, setAttachments] = useState<
    { path: string; name: string }[]
  >([]);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const messagesContainerRef = React.useRef<HTMLDivElement>(null);
  const page = 1;

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

  const messages: TicketMessage[] = messagesData?.results ?? [];

  // Track previous ticket ID to detect ticket changes
  const prevTicketIdRef = React.useRef<number | null>(null);
  const isTicketChanged = ticket?.id !== prevTicketIdRef.current;

  React.useEffect(() => {
    if (ticket?.id) {
      prevTicketIdRef.current = ticket.id;
    }
  }, [ticket?.id]);

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

  // Focus the input shortly after opening
  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, [open]);

  const handleSendMessage = async () => {
    if (!messageText.trim() || !ticket) return;

    const currentText = messageText.trim();
    const currentAttachments = [...attachments];

    setMessageText("");
    setAttachments([]);

    try {
      const newMessage = await postMessage({
        ticket_id: ticket.id.toString(),
        message_type: "public",
        body: currentText,
      });

      if (currentAttachments.length > 0 && newMessage?.id) {
        setIsUploadingAttachments(true);

        try {
          await Promise.all(
            currentAttachments.map((att) =>
              uploadAttachment({
                ticket_id: ticket.id.toString(),
                message_id: newMessage.id.toString(),
                filePath: att.path,
                filename: att.name,
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

      await refetch();

      setTimeout(() => {
        scrollToBottom();
      }, 50);
    } catch (error) {
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

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAttachClick = async () => {
    const result = await selectFilePath(false);
    if (result) {
      setAttachments((prev) => [...prev, result]);
    }
  };

  const handleRefresh = async () => {
    await refetch();
    setTimeout(() => {
      scrollToBottom();
    }, 0);
  };

  const inputDisabled =
    isPosting || isUploadingAttachments || ticket?.status === "closed";
  const showInitialLoader = isLoading || isTicketChanged;
  const isRefreshing = isFetching && !showInitialLoader;

  return (
    <Dialog.Root open={open} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed bottom-4 right-4 z-[10001] flex h-[514px] max-h-[calc(100vh-32px)] w-[378px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[12px] border border-grey-dark-100 bg-grey-light-200 shadow-[0px_144px_40px_0px_rgba(0,0,0,0),0px_92px_37px_0px_rgba(0,0,0,0.01),0px_52px_31px_0px_rgba(0,0,0,0.05),0px_23px_23px_0px_rgba(0,0,0,0.09),0px_6px_13px_0px_rgba(0,0,0,0.1)] focus:outline-none",
            "max-sm:left-4 max-sm:right-4 max-sm:w-auto",
            "dark:border-black-300 dark:bg-black-500 dark:shadow-[0px_0px_0px_1px_black,0px_110px_31px_0px_rgba(0,0,0,0.01),0px_70px_28px_0px_rgba(0,0,0,0.05),0px_39px_24px_0px_rgba(0,0,0,0.18),0px_18px_18px_0px_rgba(0,0,0,0.3),0px_4px_10px_0px_rgba(0,0,0,0.35)]"
          )}
        >
          {/* Header — title + close */}
          <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-grey-dark-100 bg-grey-light-200 px-4 shadow-[inset_0px_2px_0px_0px_white] dark:border-black-900 dark:bg-black-primary-bg dark:shadow-[inset_0px_2px_0px_0px_rgba(255,255,255,0.06)]">
            <Dialog.Title className="truncate pr-4 text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-black-700 dark:text-grey-light-100">
              {ticket?.subject || "Ticket Details"}
            </Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-black-700 transition-opacity hover:opacity-60 focus-visible:outline-none dark:text-grey-light-100"
              aria-label="Close dialog"
            >
              <X className="size-5" />
            </button>
          </div>

          {/* Messages list */}
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto px-[15px] py-[14px]"
          >
            {showInitialLoader ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-primary-50" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm font-medium text-grey-dark-800 dark:text-grey-dark-800">
                  No messages yet
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {messages.map((message, index) => {
                  const isStaff =
                    message.author_is_staff ||
                    (!message.author_is_staff &&
                      !message.author_is_requester);
                  const isFirstMessage = index === 0;
                  const inlineStatus = ticket
                    ? getInlineStatus(ticket.status)
                    : null;

                  return (
                    <div
                      key={message.id}
                      className={cn(
                        "flex",
                        isStaff ? "justify-start" : "justify-end"
                      )}
                    >
                      {isFirstMessage && ticket && inlineStatus ? (
                        <div
                          className={cn(
                            "w-[264px] overflow-hidden border border-grey-dark-100 bg-white shadow-[0px_2px_0px_0px_white] dark:border-black-300 dark:bg-black-600 dark:shadow-[0px_0px_0px_1px_black]",
                            isStaff
                              ? "rounded-br-[12px] rounded-tl-[12px] rounded-tr-[12px]"
                              : "rounded-bl-[12px] rounded-tl-[12px] rounded-tr-[12px]"
                          )}
                        >
                          <div className="flex items-center gap-2 border-b border-grey-dark-100 bg-white px-2 py-2 shadow-[inset_0px_2px_0px_0px_white] dark:border-black-900 dark:bg-black-600 dark:shadow-[0px_2px_0px_0px_rgba(255,255,255,0.06)]">
                            <inlineStatus.Icon
                              className={cn(
                                "size-4 shrink-0",
                                inlineStatus.iconClassName
                              )}
                              strokeWidth={1.8}
                            />
                            <span
                              className={cn(
                                "text-xs font-medium tracking-[-0.24px]",
                                inlineStatus.textClassName
                              )}
                            >
                              {inlineStatus.label}
                            </span>
                            <div className="size-2 shrink-0 rounded-[4px] bg-grey-light-500 dark:bg-grey-light-100" />
                            <span
                              className={cn(
                                "text-xs font-medium tracking-[-0.24px]",
                                getSeverityColor(ticket.priority)
                              )}
                            >
                              {formatSeverity(ticket.priority)}
                            </span>
                          </div>
                          <div className="bg-white px-3 py-3 dark:bg-black-600">
                            <TicketMessageComponent
                              isStaff={isStaff}
                              message={message}
                              showContainer={false}
                            />
                          </div>
                        </div>
                      ) : (
                        <TicketMessageComponent
                          message={message}
                          isStaff={isStaff}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer — refresh row + input */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="flex h-8 w-full items-center justify-between border-t border-grey-dark-100 bg-grey-light-400 px-4 text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-grey-dark-800 shadow-[inset_0px_2px_0px_0px_white] transition-colors hover:text-grey-20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-black-900 dark:bg-black-primary-bg dark:text-grey-dark-800 dark:shadow-[inset_0px_2px_0px_0px_rgba(255,255,255,0.06)] dark:hover:text-grey-dark-200"
            >
              <span>Refresh</span>
              <Refresh3
                className={cn("size-4", isRefreshing && "animate-spin")}
              />
            </button>

            <div className="border-t border-grey-dark-100 bg-[#ebebeb] p-2 shadow-[inset_0px_2px_0px_0px_white] dark:border-black-900 dark:bg-black-500 dark:shadow-[inset_0px_2px_0px_0px_rgba(255,255,255,0.06)]">
              {attachments.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {attachments.map((att, index) => (
                    <div
                      key={`${att.name}-${index}`}
                      className="flex items-center gap-2 rounded-[8px] border border-grey-dark-100 bg-white px-2 py-1 shadow-[0px_2px_0px_0px_white] dark:border-black-300 dark:bg-black-primary-bg dark:shadow-[0px_0px_0px_1px_black]"
                    >
                      <span className="max-w-[220px] truncate text-xs font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-dark-500">
                        {att.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveAttachment(index)}
                        disabled={inputDisabled}
                        className="text-grey-dark-800 transition-colors hover:text-grey-20 disabled:opacity-50 dark:text-grey-dark-800 dark:hover:text-grey-light-100"
                        aria-label={`Remove ${att.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex min-h-[36px] items-center gap-2 rounded-[8px] border border-grey-dark-100 bg-white px-3 py-2 shadow-[0px_2px_0px_0px_white] dark:border-black-300 dark:bg-black-primary-bg dark:shadow-[0px_0px_0px_1px_black]">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Start typing"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={inputDisabled}
                  className="min-w-0 flex-1 bg-transparent text-[14px] font-medium leading-5 tracking-[-0.28px] text-black-700 placeholder:text-grey-dark-600 focus:outline-none disabled:opacity-50 dark:text-grey-dark-500 dark:placeholder:text-grey-dark-600"
                />
                <button
                  type="button"
                  onClick={handleAttachClick}
                  className="inline-flex shrink-0 items-center justify-center text-black-700/60 transition-colors hover:text-black-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-grey-light-100/70 dark:hover:text-grey-light-100"
                  disabled={inputDisabled}
                  aria-label="Attach files"
                >
                  <LinkChain className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={!messageText.trim() || inputDisabled}
                  className="inline-flex shrink-0 items-center justify-center text-grey-dark-700 transition-colors hover:text-grey-20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
                  aria-label="Send message"
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
