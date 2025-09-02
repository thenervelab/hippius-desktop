"use client";

import React, { ReactNode, useState, useRef, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  CloseCircle,
  HippiusLogo,
  TaoLogo,
} from "@/components/ui/icons";
import { Graphsheet } from "@/components/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import TaoTopUp from "./TaoTopUp";
import { ArrowLeft, CreditCard } from "lucide-react";
import { P } from "@/components/ui/typography";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";

const PAYMENT_METHOD_OPTIONS = ["tao", "fiat"] as const;

type PaymentTypes = (typeof PAYMENT_METHOD_OPTIONS)[number];

const TAB_LABELS: Record<PaymentTypes, { Icon: ReactNode; label: string }> = {
  tao: {
    Icon: <TaoLogo className="absolute size-4" />,
    label: "Pay with $ TAO",
  },
  fiat: {
    Icon: <CreditCard className="absolute size-4" />,
    label: "Pay with Credit Card",
  },
};

const TopUpDialog: React.FC<{ trigger: ReactNode }> = ({ trigger }) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paymentType, setPaymentType] = useState<PaymentTypes | null>(null);
  const creditCardLinkRef = useRef<HTMLAnchorElement>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Check for URL parameter to auto-open dialog
  useEffect(() => {
    const openTopUp = searchParams.get("addCredits");
    if (openTopUp === "true") {
      setDialogOpen(true);
      const currentParams = new URLSearchParams(searchParams.toString());
      currentParams.delete("addCredits");
      const newUrl = currentParams.toString()
        ? `${window.location.pathname}?${currentParams.toString()}`
        : window.location.pathname;
      router.replace(newUrl, { scroll: false });
    }
  }, [searchParams, router]);

  const handlePaymentOptionClick = (option: PaymentTypes) => {
    if (option === "fiat") {
      setDialogOpen(false);
      setTimeout(() => {
        creditCardLinkRef.current?.click();
      }, 100);
    } else {
      setPaymentType(option);
    }
  };

  return (
    <>
      {/* Hidden link for credit card option */}
      <Link
        href="/billing/plans"
        ref={creditCardLinkRef}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      >
        Credit Card Plans
      </Link>

      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
        }}
      >
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>

        <Dialog.Portal>
          <Dialog.Overlay className="bg-white/70 fixed px-4 z-10 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
            <Dialog.Content className="relative p-4 border shadow-dialog bg-white flex flex-col max-w-[428px] max-h-[75vh] h-[560px] overflow-y-auto custom-scrollbar-thin border-grey-80 bg-background-1 rounded sm:rounded-[8px] overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
              <div className="z-10 absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
              <Graphsheet
                majorCell={{
                  lineColor: [246, 248, 254, 1.0],
                  lineWidth: 2,
                  cellDim: 50,
                }}
                minorCell={{
                  lineColor: [255, 255, 255, 1.0],
                  lineWidth: 0,
                  cellDim: 0,
                }}
                className="absolute w-full h-full left-0 top-0"
              />
              <div className="flex items-center text-grey-10 relative mt-2 sm:mt-0">
                {paymentType && (
                  <button
                    className="mr-3"
                    onClick={() => {
                      setPaymentType(null);
                    }}
                  >
                    <ArrowLeft className="size-6" />
                  </button>
                )}
                {!paymentType && (
                  <div className="px-1 py-1 bg-primary-50 flex justify-center items-center rounded-[8px] sm:hidden">
                    <HippiusLogo className="size-5 text-white" />
                  </div>
                )}
                {paymentType && (
                  <div className="sm:hidden text-[22px] lg:text-2xl flex justify-center w-full font-medium relative">
                    <Dialog.Title className="text-center">
                      {paymentType
                        ? `Pay with ${paymentType === "tao"
                          ? "$ " + paymentType.toUpperCase()
                          : "Credit Card"
                        }`
                        : "Add Credits"}
                    </Dialog.Title>
                  </div>
                )}
                <div className="hidden text-[22px] lg:text-2xl sm:flex w-full font-medium relative">
                  <Dialog.Title className="capitalize">
                    {paymentType
                      ? `Pay with ${paymentType === "tao"
                        ? "$ " + paymentType.toUpperCase()
                        : "Credit Card"
                      }`
                      : "Add Credits"}
                  </Dialog.Title>
                </div>
                <button
                  className="ml-auto"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  <CloseCircle className="size-6 relative text-grey-10" />
                </button>
              </div>

              <div className="pt-2 grow flex flex-col relative">
                {!paymentType && (
                  <div className="relative">
                    <div className="sm:hidden text-[22px] lg:text-2xl flex justify-center w-full font-medium relative text-grey-10">
                      <Dialog.Title className="capitalize">
                        Add Credits
                      </Dialog.Title>
                    </div>
                    <P
                      className="mb-8 text-grey-60 sm:max-w-[90%] text-center sm:text-left"
                      size="sm"
                    >
                      Choose how you want to add credits to your wallet
                    </P>
                    <div className="relative flex flex-col gap-y-4 w-full">
                      {PAYMENT_METHOD_OPTIONS.map((option) => {
                        const { Icon, label } = TAB_LABELS[option];
                        return (
                          <div
                            key={option}
                            className="w-full flex justify-between items-center border bg-white hover:bg-grey-90 duration-300 border-grey-80 p-2 rounded cursor-pointer"
                            onClick={() => handlePaymentOptionClick(option)}
                          >
                            <button className="flex items-center">
                              <AbstractIconWrapper
                                className="relative size-6"
                              >
                                {Icon}
                              </AbstractIconWrapper>{" "}
                              <span className="ml-1.5 text-grey-10 font-medium">
                                {label}
                              </span>
                            </button>

                            <ArrowRight className="size-4 text-grey-10" />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {paymentType === "tao" && (
                  <TaoTopUp closeDialog={() => setDialogOpen(false)} />
                )}
              </div>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
};

export default TopUpDialog;
