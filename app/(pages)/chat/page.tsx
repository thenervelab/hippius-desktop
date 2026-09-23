import type { Metadata } from "next";

import ChatRoute from "@/components/chat/ChatRoute";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";

export const metadata: Metadata = {
  title: "Hippius Console - Chat",
  description: "End-to-end encrypted team chat",
};

/**
 * `/chat`. Everything stateful is client-only inside `ChatRoute` (the
 * Matrix SDK needs the webview); this file only names the route and the
 * page title, like the other `(pages)` entries.
 */
const ChatPage: React.FC = () => (
  <DashboardTitleWrapper mainText="Team chat">
    <ChatRoute />
  </DashboardTitleWrapper>
);

export default ChatPage;
