import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import DialogContainer from "../../ui/dialog-container";
import { AbstractIconWrapper, CardButton, Icons } from "../../ui";
import QRCode from "react-qr-code";
import CopyText from "../../ui/copy-text";

export interface ReceiveBalanceDialogProps {
  open: boolean;
  onClose: () => void;
  polkadotAddress: string;
}

const ReceiveBalanceDialog: React.FC<ReceiveBalanceDialogProps> = ({
  open,
  onClose,
  polkadotAddress,
}) => {
  // Format the address for display (truncate in the middle)
  const formatAddress = (address: string) => {
    if (!address || address.length < 10) return address;
    return `${address.substring(0, 20)}...${address.substring(address.length - 3)}`;
  };

  const displayAddress = polkadotAddress ? formatAddress(polkadotAddress) : "";
  const fullAddress = polkadotAddress || "";

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContainer
        className="md:inset-0 md:m-auto
          md:w-[90vw] md:max-w-[428px] h-fit"
      >
        <Dialog.Title className="sr-only">Receive Balance</Dialog.Title>
        {/* Top accent bar (only mobile) */}
        <div className="h-4 bg-primary-50 md:hidden block" />

        <div className="px-4">
          {/* Desktop Header */}
          <div className="hidden md:flex flex-col items-center justify-center pb-4 pt-4 gap-2">
            <div className="flex items-center mb-2 p-2">
              <AbstractIconWrapper className="size-8 sm:size-10">
                <Icons.RecieveSquare className="absolute size-4 sm:size-6 text-primary-50" />
              </AbstractIconWrapper>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Receive Balance
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <div className="text-lg font-medium relative">
              <span className="capitalize">Receive Balance</span>
            </div>
            <button onClick={onClose}>
              <Icons.CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Deposit Address Label */}
          <div className="text-sm font-medium text-grey-70 mb-2">
            Deposit Address
          </div>

          {/* QR Code */}
          <div className="w-full flex justify-center mb-4">
            <div className="border border-grey-80 rounded-lg p-4 bg-white w-full flex items-center justify-center flex-col gap-[22px]">
              <div className="w-[194px] h-[194px] flex items-center justify-center">
                <QRCode
                  value={fullAddress}
                  size={194}
                  style={{ height: "auto", maxWidth: "100%", width: "100%" }}
                  viewBox={`0 0 256 256`}
                />
              </div>
              {/* Address with Copy Button */}
              <div className="   w-full">
                <CopyText
                  text={fullAddress}
                  title="Copy address"
                  isJustifyCenter
                  buttonClass="px-1.5 py-1 border border-grey-80 rounded bg-grey-90 "
                  toastMessage="Address copied to clipboard"
                  className="flex items-center justify-between"
                  copyIconClassName="size-5 text-grey-10"
                  checkIconClassName="size-5"
                >
                  <div className=" text-grey-10 font-semibold text-base">
                    {displayAddress}
                  </div>
                </CopyText>
              </div>
            </div>
          </div>

          {/* Cancel Button */}
          <div className="mb-6">
            <CardButton
              className="w-full text-[18px]"
              variant="secondary"
              onClick={onClose}
            >
              Close
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default ReceiveBalanceDialog;
