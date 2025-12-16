import { PlusCircle, Loader2 } from "lucide-react";

import React, { FC } from "react";
import { CardButton } from "..";

interface CreateButtonProps {
  text: string;
  isLoading: boolean;
  onClick: () => void;
  className?: string;
}

const CreateButton: FC<CreateButtonProps> = ({
  text,
  isLoading,
  onClick,
  className = "w-fit",
}) => {
  return (
    <CardButton
      className={`flex gap-x-2 items-center  h-10 ${className}`}
      icon={<PlusCircle className="size-4" />}
      appendToStart
      onClick={onClick}
    >
      {isLoading ? <Loader2 className="animate-spin size-4" /> : text}
    </CardButton>
  );
};

export default CreateButton;
