import * as Menubar from "@radix-ui/react-menubar";

interface UnitMenuItemProps {
  unit: string;
  onClick: () => void;
}

export const UnitMenuItem: React.FC<UnitMenuItemProps> = ({
  unit,
  onClick,
}) => {
  return (
    <Menubar.Item
      className="flex items-center p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
      onClick={onClick}
    >
      <span className="flex-1">{unit}</span>
    </Menubar.Item>
  );
};
