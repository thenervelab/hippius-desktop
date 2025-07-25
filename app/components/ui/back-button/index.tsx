import React from "react";
import { Icons } from "@/components/ui";

interface BackButtonProps {
  onBack: () => void;
}

const BackButton: React.FC<BackButtonProps> = ({ onBack }) => {
  return (
    <button
      className="flex gap-2 font-semibold text-lg items-center"
      onClick={onBack}
    >
      <Icons.ArrowLeft className="size-5 text-grey-10" />
      Back
    </button>
  );
};

export default BackButton;
