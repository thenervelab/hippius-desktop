"use client";

import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu } from "@tauri-apps/api/menu";
import { isTauri } from "@tauri-apps/api/core";

const TrayInitialiser: React.FC = () => {
  if (!isTauri()) return;

  const init = async () => {
    const menu = await Menu.new({
      items: [
        {
          id: "quit",
          text: "Quit",
          action: () => {
            console.log("quit pressed");
          },
        },
      ],
    });

    const options = {
      menu,
      menuOnLeftClick: true,
    };
    const tray = await TrayIcon.new(options);

    tray.setShowMenuOnLeftClick(true);
    tray.setTooltip("Hippius");

    return tray;
  };

  init();

  return null;
};

export default TrayInitialiser;
