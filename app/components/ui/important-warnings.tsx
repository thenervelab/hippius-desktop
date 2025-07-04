import React from "react";
import { RevealTextLine, Icons } from ".";
import { OctagonAlert } from "./icons";

interface ImportantWarningsProps {
  inView?: boolean;
  usePasscode?: boolean;
  className?: string;
}

const ImportantWarnings: React.FC<ImportantWarningsProps> = ({
  inView = true,
  usePasscode = false,
  className = "",
}) => {
  const keyWord = usePasscode ? "passcode" : "key";

  const warnings = [
    {
      id: 1,
      text: `Store this ${keyWord} in a secure password manager`,
    },
    {
      id: 2,
      text: "Never share it with anyone",
    },
    {
      id: 3,
      text: (
        <div>
          We <b>cannot</b> help you recover your account if you lose this{" "}
          {keyWord}
        </div>
      ),
    },
  ];

  return (
    <div className={className}>
      <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
        <div className="flex gap-2 xl:pt-5 pt-3 xl:pb-4 pb-3 items-center">
          <OctagonAlert className="text-warning-50 size-6" />
          <span className="text-lg font-semibold text-grey-10">Important</span>
        </div>
      </RevealTextLine>

      <div className="flex flex-col gap-2">
        {warnings?.map((item) => {
          return (
            <RevealTextLine
              rotate
              reveal={inView}
              className="delay-500 w-full"
              key={item?.id}
            >
              <div className="text-grey-50 font-medium text-sm flex gap-2 items-center">
                <Icons.ArrowRight className="text-grey-80 size-5" />
                <span>{item?.text}</span>
              </div>
            </RevealTextLine>
          );
        })}
      </div>
    </div>
  );
};

export default ImportantWarnings;
