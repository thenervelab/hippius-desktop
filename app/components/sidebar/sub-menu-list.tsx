import { SubMenuItemData } from "./nav-data";
import SubMenuItem from "./sub-menu-item";

interface SubMenuListProps {
  items: SubMenuItemData[];
  inView?: boolean;
  onItemClick?: () => void; // NEW
}

const SubMenuList: React.FC<SubMenuListProps> = ({
  items,
  inView = true,
  onItemClick
}) => {
  return (
    <div className="min-w-[163px] bg-white rounded-md flex gap-1 flex-col p-2">
      {items.map((item, index) => (
        <SubMenuItem
          key={`submenu-item-${index}`}
          {...item}
          inView={inView}
          onItemClick={onItemClick}
        />
      ))}
    </div>
  );
};
export default SubMenuList;
