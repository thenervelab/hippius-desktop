import { IconComponent } from "@/app/lib/types";

export interface UiNotification {
  id: number;
  icon: IconComponent;
  type: string;
  subType: string;
  title: string;
  description: string;
  buttonText?: string;
  buttonLink?: string;
  unread: boolean;
  time: string;
  timestamp?: number; // Add timestamp for TimeAgo component
}
