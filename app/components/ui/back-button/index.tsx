import React, { useCallback } from "react";
import { Icons } from "@/components/ui";
import { useRouter } from "next/navigation";

interface BackButtonProps {
  onBack?: () => void;
  href?: string;
  text?: string;
}

const BackButton: React.FC<BackButtonProps> = ({
  onBack,
  href,
  text = "Back",
}) => {
  const router = useRouter();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (onBack) {
        onBack();
        return;
      }
      const hasHistory =
        typeof window !== "undefined" && window.history.length > 2;

      if (!hasHistory && href) {
        router.push(href);
      } else {
        router.back();
      }
    },
    [router, href, onBack]
  );
  return (
    <button
      type="button"
      className="inline-flex self-start w-auto gap-1 font-medium text-sm items-center py-1 px-2 border border-grey-80 bg-grey-90 hover:bg-grey-80 rounded text-grey-20 transition-colors duration-200"
      onClick={handleClick}
    >
      <Icons.ArrowLeft className="size-[15px] text-grey-20" />
      {text}
    </button>
  );
};

export default BackButton;
