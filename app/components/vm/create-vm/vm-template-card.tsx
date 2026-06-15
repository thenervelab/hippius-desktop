import React from "react";
import { MoreVertical } from "lucide-react";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Button, Icons } from "../../ui";
import { cn } from "@/lib/utils";

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
    <div className="bg-grey-light-100 border border-grey-dark-100 rounded-[8px] overflow-hidden flex flex-col items-center gap-[14px] pb-[8px] dark:bg-black-600 dark:border-black-300">
      {/* Header */}
      <div className="bg-grey-light-300 border-b-[0.884px] border-grey-dark-100 shadow-[0px_0.884px_0px_0px_white] flex gap-[8px] items-center overflow-hidden px-[8px] py-[8.842px] w-full dark:bg-black-primary-bg dark:border-black-300 dark:shadow-[0px_0.884px_0px_0px_rgba(255,255,255,0.06)]">
        <Icons.SquareLibrary className="size-[18px] text-primary-50 shrink-0" />
        <p className="flex-1 font-medium text-[14px] leading-normal tracking-[-0.28px] text-grey-10 dark:text-grey-light-300 min-w-0 truncate">
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
            <button className="text-grey-70 hover:bg-grey-90 p-1 rounded transition shrink-0">
              <MoreVertical className="size-4" />
            </button>
          </TableActionMenu>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col gap-[12px] px-[8px] w-full">
        {/* RAM and Cores */}
        <div className="flex items-start w-full">
          {/* RAM */}
          <div className="flex-1 flex flex-col gap-[1.768px] min-w-0">
            <div className="flex gap-[3.537px] items-center w-full">
              <Icons.Cpu className="size-[14.147px] shrink-0 text-grey-10 dark:text-grey-light-300" />
              <p className="font-mono font-medium text-[12px] leading-[19.452px] tracking-[-0.24px] uppercase text-grey-10 dark:text-grey-light-300 whitespace-nowrap">
                RAM
              </p>
            </div>
            <p className="font-medium text-[10px] leading-[17.683px] tracking-[-0.2px] text-grey-dark-600 w-full">
              {template.ramValue}
            </p>
          </div>

          {/* Cores */}
          <div className="flex-1 flex flex-col gap-[1.768px] min-w-0">
            <div className="flex gap-[3.537px] items-center w-full">
              <Icons.CpuCharge className="size-[14.147px] shrink-0 text-grey-10 dark:text-grey-light-300" />
              <p className="font-mono font-medium text-[12px] leading-[19.452px] tracking-[-0.24px] uppercase text-grey-10 dark:text-grey-light-300 whitespace-nowrap">
                Cores
              </p>
            </div>
            <p className="font-medium text-[10px] leading-[17.683px] tracking-[-0.2px] text-grey-dark-600 w-full">
              {template.coresValue}
            </p>
          </div>
        </div>

        {/* Other Specifications */}
        <div className="flex flex-col gap-[1.768px] w-full">
          <div className="flex gap-[3.537px] items-center w-full">
            <Icons.Grip className="size-[14.147px] shrink-0 text-grey-10 dark:text-grey-light-300" />
            <p className="font-mono font-medium text-[12px] leading-[19.452px] tracking-[-0.24px] uppercase text-grey-10 dark:text-grey-light-300 whitespace-nowrap">
              Other Specifications
            </p>
          </div>
          <div className="flex gap-[8px] items-center">
            <p className="font-medium text-[10px] leading-[17.683px] tracking-[-0.2px] text-grey-dark-600 whitespace-nowrap">
              {template.storage}
            </p>
            {template.bandwidth && (
              <>
                <div className="size-1 rounded-full bg-grey-dark-600 shrink-0" />
                <p className="font-medium text-[10px] leading-[17.683px] tracking-[-0.2px] text-grey-dark-600 whitespace-nowrap">
                  {template.bandwidth}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Price */}
        <div
          className={cn(
            "flex flex-col gap-[1.768px] w-full",
            !showSetupButton && "pb-[8px]",
          )}
        >
          <div className="flex gap-[3.537px] items-center w-full">
            <Icons.DollarSquare className="size-[14.147px] shrink-0 text-grey-10 dark:text-grey-light-300" />
            <p className="font-mono font-medium text-[12px] leading-[19.452px] tracking-[-0.24px] uppercase text-grey-10 dark:text-grey-light-300 whitespace-nowrap">
              Price
            </p>
          </div>
          <p className="font-medium text-[10px] leading-[17.683px] tracking-[-0.2px] text-grey-dark-600 whitespace-nowrap">
            {template.price}
          </p>
        </div>
      </div>

      {/* Button */}
      {showSetupButton && onSelect && (
        <div className="px-[8px] w-full">
          <Button
            variant="primary"
            size="auto"
            className="w-full flex items-center justify-center gap-[6px] px-[10px] py-[4px] text-[14px] font-medium leading-[22px] tracking-[-0.28px] rounded-[6px]"
            onClick={() => onSelect(template)}
          >
            <span>Setup VM</span>
            <Icons.ArrowRight className="size-[19px]" />
          </Button>
        </div>
      )}
    </div>
  );
};

export default VMTemplateCard;
