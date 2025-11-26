import { ReactNode } from "react";

export const APP_SETUP_PHASES = [
  "checking_binary",
  "downloading_nebula",
  "installing_nebula",
  "verifying_installation",
  "ready",
] as const;

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
};

export const APP_SETUP_EVENT = "app_setup_event";
