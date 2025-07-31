import * as Menubar from "@radix-ui/react-menubar";
import ActiveTabBg from "@/app/components/ui/tabs/active-tab-bg";
import { Icons } from "../../ui";

interface Option {
  label: string;
  value: string;
}

interface NotificationOptionSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
}

const NotificationOptionSelect: React.FC<NotificationOptionSelectProps> = ({
  options,
  value,
  onChange
}) => {
  const selected = options.find((opt) => opt.value === value);

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <button className="relative min-w-[121px] h-[40px] px-3 flex items-center justify-between gap-2 t bg-transparent rounded-lg border-none cursor-pointer">
            {/* Active background */}
            <div className="absolute inset-0 pointer-events-none">
              <ActiveTabBg mainGroup={true} />
            </div>
            <span className="relative z-10 font-medium text-[14px] leading-5 text-grey-10">
              {selected?.label}
            </span>
            <span className="relative z-10 ml-2 border-[1.5px] flex justify-center items-center rounded size-4 border-grey-50">
              <Icons.ChevronDown className="size-[8px]" />
            </span>
          </button>
        </Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content
            align="start"
            sideOffset={8}
            className="min-w-[160px] bg-white shadow-menu rounded-lg border border-grey-80 z-50 overflow-hidden"
          >
            {options.map((opt) => (
              <Menubar.Item
                key={opt.value}
                className={`pl-6 pr-3 py-2 cursor-pointer text-xs leading-[18px] font-medium hover:text-primary-50 ${
                  value === opt.value
                    ? "text-primary-50 border-l border-primary-50"
                    : "text-grey-70"
                }`}
                onSelect={() => onChange(opt.value)}
              >
                {opt.label}
              </Menubar.Item>
            ))}
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    </Menubar.Root>
  );
};

export default NotificationOptionSelect;
