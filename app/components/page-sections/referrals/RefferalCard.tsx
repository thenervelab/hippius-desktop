import { AbstractIconWrapper } from "@/components/ui";
import { IconComponent } from "@/app/lib/types";

interface DetailsCardProps {
  icon: IconComponent;
  title: string;
  value: string | number;
}

export default function ReferralCard({
  icon: Icon,
  title,
  value
}: DetailsCardProps) {
  return (
    <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm flex justify-between flex-col">
      <div className="flex justify-between items-start">
        <AbstractIconWrapper className="size-10 text-primary-40">
          <Icon className="absolute text-primary-40 size-6" />
        </AbstractIconWrapper>
      </div>
      <div className="mt-4">
        <div className="text-base font-medium text-grey-60 mb-2">{title}</div>

        <div className="text-2xl text-grey-10 font-medium">{value}</div>
      </div>
    </div>
  );
}
