import React from "react";

interface NotificationTypeProps {
  type: string;
}

const TYPE_STYLES: Record<string, { ring: string; dot: string; label: string }> = {
  Hippius:      { ring: "bg-primary-90",  dot: "bg-primary-50",  label: "text-primary-30" },
  Files:        { ring: "bg-primary-90",  dot: "bg-primary-50",  label: "text-primary-30" },
  Storage:      { ring: "bg-primary-90",  dot: "bg-primary-50",  label: "text-primary-30" },
  Blockchain:   { ring: "bg-success-90",  dot: "bg-success-50",  label: "text-success-30" },
  Balance:      { ring: "bg-warning-90",  dot: "bg-warning-50",  label: "text-warning-30" },
  Credits:      { ring: "bg-warning-90",  dot: "bg-warning-50",  label: "text-warning-30" },
  Subscription: { ring: "bg-error-90",    dot: "bg-error-50",    label: "text-error-30"   },
};

const DEFAULT_STYLE = { ring: "bg-success-90", dot: "bg-success-50", label: "text-grey-10" };

const NotificationType: React.FC<NotificationTypeProps> = ({ type }) => {
  const style = TYPE_STYLES[type] ?? DEFAULT_STYLE;

  return (
    <div className={`flex items-center justify-start self-start gap-1 px-2 py-1 ${style.ring} rounded mb-1`}>
      <span className={`p-1 rounded-full ${style.ring}`}>
        <span className={`block w-2 h-2 rounded-full ${style.dot}`} />
      </span>
      <span className={`text-xs leading-[1.125rem] font-medium ${style.label}`}>
        {type}
      </span>
    </div>
  );
};

export default NotificationType;
