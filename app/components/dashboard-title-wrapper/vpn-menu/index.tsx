"use client";

import { useState } from "react";
import * as Menubar from "@radix-ui/react-menubar";
import VPNIconButton from "./VPNIconButton";
import VPNMenuContent from "./VPNMenuContent";
import { useAtom } from "jotai";
import { vpnConnectedAtom } from "./vpnAtoms";

type Props = {
  className?: string;
};

export default function VPNMenu({ className = "delay-500" }: Props) {
  const [menuValue, setMenuValue] = useState<string>("");
  const [isConnected] = useAtom(vpnConnectedAtom);

  return (
    <Menubar.Root
      className="h-full flex items-center"
      value={menuValue}
      onValueChange={setMenuValue}
    >
      <Menubar.Menu value="vpn">
        <Menubar.Trigger asChild>
          <button>
            <VPNIconButton className={className} isConnected={isConnected} />
          </button>
        </Menubar.Trigger>

        <Menubar.Portal>
          <Menubar.Content
            align="center"
            sideOffset={5}
            className="w-[400px] bg-white shadow-menu rounded-lg border border-grey-80 -translate-x-2 z-50"
          >
            <Menubar.Arrow
              className="fill-grey-100  stroke stroke-grey-80 translate-y-[-1px] z-[-1]"
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
