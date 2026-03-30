"use client";

import { useState } from "react";
import * as Menubar from "@radix-ui/react-menubar";
import VPNIconButton from "./VPNIconButton";
import VPNMenuContent from "./VPNMenuContent";

type Props = {
  className?: string;
};

export default function VPNMenu({ className = "delay-500" }: Props) {
  const [menuValue, setMenuValue] = useState<string>("");

  return (
    <Menubar.Root
      className="h-full flex items-center"
      value={menuValue}
      onValueChange={setMenuValue}
    >
      <Menubar.Menu value="vpn">
        <Menubar.Trigger asChild>
          <button>
            <VPNIconButton className={className} />
          </button>
        </Menubar.Trigger>

        <Menubar.Portal>
          <Menubar.Content
            align="center"
            sideOffset={5}
            className="w-[25rem] bg-white shadow-menu rounded-lg border border-grey-80 -translate-x-2 z-50"
          >
            <Menubar.Arrow
              className="fill-grey-100  stroke stroke-grey-80 translate-y-[-0.0625rem] z-[-1]"
              height={18}
              width={20.78}
            />

            <VPNMenuContent />
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    </Menubar.Root>
  );
}
