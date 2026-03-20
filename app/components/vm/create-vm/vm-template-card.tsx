import React from "react";
import { MoreVertical } from "lucide-react";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Button, Icons } from "../../ui";

export interface VMTemplate {
  id: string;
  name: string;
  ram: string;
  ramValue: string;
  cores: string;
  coresValue: string;
  storage: string;
  bandwidth: string;
  price: string;
  category: string;
}

interface VMTemplateCardProps {
  template: VMTemplate;
  onSelect?: (template: VMTemplate) => void;
  onDelete?: (template: VMTemplate) => void;
  showSetupButton?: boolean;
  hideMenu?: boolean;
}

const VMTemplateCard: React.FC<VMTemplateCardProps> = ({
  template,
  onSelect,
  onDelete,
  showSetupButton = true,
  hideMenu = false,
}) => {
  return (
    <div className="bg-grey-100 border border-grey-80 rounded-lg overflow-hidden flex flex-col gap-4 p-0">
      {/* Header */}
      <div className="bg-grey-100 border-b border-grey-80 flex gap-2 items-center pl-4 pr-3 py-2.5">
        <Icons.Computing className="size-5 text-primary-50" />
        <p className="flex-1 font-medium leading-6 text-lg text-grey-10 tracking-tight">
          {template.name}
        </p>
        {!hideMenu && !showSetupButton && onDelete && (
          <TableActionMenu
            dropdownTitle="Template Options"
            items={[
              {
                icon: <Icons.Trash className="size-4" />,
                itemTitle: "Delete Template",
                onItemClick: () => onDelete(template),
                variant: "destructive",
              },
            ]}
          >
            <button className="text-grey-70 hover:bg-grey-90 p-1 rounded transition">
              <MoreVertical className="size-4" />
            </button>
          </TableActionMenu>
        )}
      </div>

      {/* Content */}
      <div
        className={`flex flex-col gap-2 px-4 ${!showSetupButton ? "pb-4" : ""}`}
      >
        {/* RAM and Cores */}
        <div className="flex items-start w-full">
          {/* RAM */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Icons.Cpu className="size-4 text-grey-10" />
              <p className="font-medium leading-[22px] text-base text-grey-10 tracking-tight">
                RAM
              </p>
            </div>
            <p className="font-medium leading-5 text-sm text-grey-70 tracking-tight">
              {template.ramValue}
            </p>
          </div>

          {/* Cores */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Icons.CpuCharge className="size-4 text-grey-10" />
              <p className="font-medium leading-[22px] text-base text-grey-10 tracking-tight">
                Cores
              </p>
            </div>
            <p className="font-medium leading-5 text-sm text-grey-70 tracking-tight">
              {template.coresValue}
            </p>
          </div>
        </div>

        {/* Other Specifications */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Icons.MoreSquare className="size-4 text-grey-10" />
            <p className="font-medium leading-[22px] text-base text-grey-10 tracking-tight">
              Other Specifications
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <p className="font-medium leading-5 text-sm text-grey-70 tracking-tight">
              {template.storage}
            </p>
            {template.bandwidth && (
              <>
                <div className="size-1 rounded-full bg-grey-80" />
                <p className="font-medium leading-5 text-sm text-grey-70 tracking-tight">
                  {template.bandwidth}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Price */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Icons.DollarSquare className="size-4 text-grey-10" />
            <p className="font-medium leading-[22px] text-base text-grey-10 tracking-tight">
              Price
            </p>
          </div>
          <p className="font-medium leading-5 text-sm text-grey-70 tracking-tight">
            {template.price}
          </p>
        </div>
      </div>

      {/* Button */}
      {showSetupButton && onSelect && (
        <div className="px-4 pb-4">
          <Button
            className={`flex gap-x-2 items-center  h-[42px] w-full`}
            icon={<Icons.ArrowRight className="size-4" />}
            onClick={() => onSelect(template)}
          >
            {" "}
            <span className="font-medium text-base leading-[22px] tracking-tight">
              Set Up Virtual Machine
            </span>
          </Button>
        </div>
      )}
    </div>
  );
};

export default VMTemplateCard;
