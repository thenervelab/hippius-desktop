import { ReactNode } from "react";

export const APP_SETUP_PHASES = [
  "checking_binary",
  "downloading_binary",
  "configuring_cors",
  "starting_daemon",
  "connecting_to_network",
  "initialising_database",
  "syncing_data",
  "ready",
] as const;

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
};

export const APP_SETUP_EVENT = "app_setup_event";
