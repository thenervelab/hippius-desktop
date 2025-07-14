import Link from "next/link";

interface NotificationMenuFooterProps {
  onClose?: () => void;
}

const NotificationMenuFooter: React.FC<NotificationMenuFooterProps> = ({ onClose }) => (
  <div className="flex items-center justify-end p-4 border-t border-grey-80">
    <Link
      href="/notifications"
      onClick={onClose}
      className="text-grey-10 font-medium text-sm hover:underline"
    >
      View all notifications
    </Link>
  </div>
);

export default NotificationMenuFooter;
