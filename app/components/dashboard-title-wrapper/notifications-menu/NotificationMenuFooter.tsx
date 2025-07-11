import Link from "next/link";

const NotificationMenuFooter: React.FC = () => (
  <div className="flex items-center justify-end p-4 border-t border-grey-80">
    <Link
      href="/notifications"
      className="text-grey-10 font-medium text-sm hover:underline"
    >
      View all notifications
    </Link>
  </div>
);

export default NotificationMenuFooter;
