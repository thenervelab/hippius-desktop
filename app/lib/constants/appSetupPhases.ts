import { ReactNode } from "react";

export const APP_SETUP_PHASES = [
  "checking_binary",
  "starting_daemon",
  "connecting_to_network",
  "ready",
] as const;

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
};

export const APP_SETUP_EVENT = "app_setup_event";
