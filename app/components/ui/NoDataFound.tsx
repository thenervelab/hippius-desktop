import React from "react";
import { LucideIcon } from "lucide-react";
import { Graphsheet } from ".";
import CreateButton from "./button/CreateButton";

interface NoDataFoundProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  buttonText?: string;
  onButtonClick?: () => void;
  isLoading?: boolean;
  showButton?: boolean;
}

const NoDataFound: React.FC<NoDataFoundProps> = ({
  icon: Icon,
  title,
  description,
  buttonText,
  onButtonClick,
  isLoading = false,
  showButton = true,
}) => {
  return (
    <div className="min-h-[42.5rem] flex flex-col items-center justify-center">
      <div className="text-2xl font-medium text-grey-10 flex flex-col items-center justify-center pt-4 gap-4">
        <div className="flex items-center sm:justify-center h-[3.5rem] w-[3.5rem] relative">
          <Graphsheet
            majorCell={{
              lineColor: [31, 80, 189, 1],
              lineWidth: 2,
              cellDim: 40,
            }}
            minorCell={{
              lineColor: [31, 80, 189, 1],
              lineWidth: 2,
              cellDim: 40,
            }}
            className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-30 hidden sm:block"
          />
          <div className="bg-white-cloud-gradient-sm absolute w-full h-full" />
          <div className="flex items-center justify-center h-8 w-8 bg-primary-50 rounded-[0.5rem] relative">
            <Icon className="size-5 text-white" />
          </div>
        </div>
        <span>{title}</span>
      </div>

      {showButton && description && (
        <div className="flex flex-col items-center justify-center mt-4 max-w-[23.75rem]">
          {description && (
            <div className="text-sm text-grey-60 font-medium mb-4 text-center">
              {description}
            </div>
          )}

          {showButton && buttonText && onButtonClick && (
            <CreateButton
              text={buttonText}
              isLoading={isLoading}
              onClick={onButtonClick}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default NoDataFound;
