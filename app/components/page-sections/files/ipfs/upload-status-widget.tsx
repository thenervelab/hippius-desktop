import CircularProgress from "@/components/ui/circular-progress";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";
import {
  uploadProgressAtom,
  uploadToIpfsAndSubmitToBlockcahinRequestStateAtom,
} from "./atoms/query-atoms";
import { useMemo } from "react";
import { lerp } from "@/lib/utils/lerp";
import { inlerp } from "@/lib/utils/inlerp";

const UploadStatusWidget: React.FC = () => {
  const requestState = useAtomValue(
    uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
  );
  const progress = useAtomValue(uploadProgressAtom);
  const angle = useMemo(
    () => lerp(0, 360, inlerp(0, 100, progress)),
    [progress]
  );

  return (
    <div
      className={cn(
        "fixed flex w-[300px] max-w-[270px] gap-x-2 shadow-dialog z-40 bottom-16 right-4 bg-white border border-grey-80 rounded-[8px] p-3.5 translate-y-32 duration-500 opacity-0",
        requestState !== "idle" && "translate-y-0 opacity-100"
      )}
    >
      <CircularProgress className="size-12" angle={angle}>
        {requestState === "submitting" && (
          <Icons.Box
            key={requestState}
            className="relative animate-fade-in-from-b-0.5 size-6 text-primary-50 opacity-0"
          />
        )}
        {requestState === "uploading" && (
          <Icons.DocumentNormal
            key={requestState}
            className="relative size-6 text-primary-50"
          />
        )}
      </CircularProgress>
      <div className="font-medium text-grey-20">
        {requestState === "uploading" && (
          <div key={requestState}>Uploading Your File</div>
        )}
        {requestState === "submitting" && (
          <div
            key={requestState}
            className="animate-fade-in-from-b-0.5 opacity-0"
          >
            Submiting to Blockchain
          </div>
        )}
        <div className="text-xs text-grey-70">
          {requestState === "submitting" && (
            <span
              key={requestState}
              className="animate-fade-in-from-b-0.5 opacity-0"
            >
              Completing handoff...{" "}
            </span>
          )}
          {requestState === "uploading" && (
            <span key={requestState}>Uploading files to IPFS.... </span>
          )}
          <span className="text-grey-10">{Math.round(progress)} %</span>
        </div>
      </div>
    </div>
  );
};

export default UploadStatusWidget;
