"use client";

import React, { useEffect, useMemo, useState } from "react";
import { InView } from "react-intersection-observer";
import * as SelectPrimitive from "@radix-ui/react-select";
import { toast } from "sonner";
import { Clock } from "lucide-react";
import { Icons, RevealTextLine, CardButton } from "@/components/ui";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from "@/components/ui/select/Select2";

import {
  getSession,
  updateSessionTimeout,
} from "@/app/lib/helpers/sessionStore";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import SectionHeader from "./SectionHeader";

const OPTIONS = [
  { label: "30 Minutes", value: 30 },
  { label: "1 Hour", value: 60 },
  { label: "8 Hours", value: 480 },
  { label: "24 Hours", value: 1440 },
  { label: "3 Days", value: 4320 },
  { label: "Forever", value: -1 },
] as const;

function labelFor(value: number) {
  return OPTIONS.find((o) => o.value === value)?.label ?? "24 Hours";
}

export default function SessionTimeoutSettings() {
  const { mnemonic, setSession } = useWalletAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initialMinutes, setInitialMinutes] = useState<number>(1440);
  const [selected, setSelected] = useState<string>("1440");

  const hasChanged = useMemo(
    () => Number(selected) !== initialMinutes,
    [selected, initialMinutes]
  );

  useEffect(() => {
    (async () => {
      try {
        const s = await getSession();
        const minutes = s?.logoutTimeInMinutes ?? 1440;
        setInitialMinutes(minutes);
        setSelected(String(minutes));
      } catch {
        setInitialMinutes(1440);
        setSelected("1440");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      const minutes = Number(selected);

      const ok = await updateSessionTimeout(minutes);
      if (!ok) throw new Error("Failed to update");
      if (mnemonic) {
        await setSession(mnemonic, minutes);
      }

      setInitialMinutes(minutes);
      toast.success("Session timeout updated", {
        description: `Now set to ${labelFor(minutes)}.`,
      });
    } catch (err) {
      console.error("[SessionTimeoutSettings] save failed:", err);
      toast.error("Could not update session timeout");
    } finally {
      setSaving(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <div className="w-full flex flex-col">
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex justify-between gap-4">
                  <SectionHeader
                    Icon={Clock}
                    title="Session Timeout"
                    subtitle=" Choose how long the app keeps you signed in."
                    info="The session timeout determines how long you stay signed in before being automatically logged out. Choose a duration that balances security and convenience."
                  />
                </div>
              </RevealTextLine>
            </div>
          </div>

          <RevealTextLine
            rotate
            reveal={inView}
            parentClassName="w-full"
            className="delay-300 w-full"
          >
            <div className="space-y-2 w-full">
              <Label className="text-sm font-medium text-grey-70">
                Duration
              </Label>

              <div className="mt-1 w-full">
                <Select
                  disabled={loading}
                  value={selected}
                  onValueChange={(v) => setSelected(v)}
                >
                  {/* NOTE: Using `group` to target open state for child icon */}
                  <SelectTrigger
                    className="group w-full flex items-center justify-between relative
                      bg-grey-100 border border-grey-80 rounded-[8px]
                      px-4 py-3 text-base font-medium text-grey-60
                      h-[56px] outline-none focus:outline-none focus-visible:outline-none
                      ring-0 focus:ring-0 focus-visible:ring-0 shadow-none focus:shadow-none focus-visible:shadow-none focus-visible:border-grey-70 data-[state=open]:border-grey-70"
                  >
                    <SelectValue placeholder="Select duration" />
                    {/* Chevron starts UP (rotate-180), rotates DOWN when open */}
                    <Icons.ChevronDown
                      className="
                        absolute size-5 right-4 top-1/2 -translate-y-1/2
                        text-grey-60 pointer-events-none
                        transition-transform duration-200 ease-out
                        rotate-180 group-data-[state=open]:rotate-0
                      "
                    />
                  </SelectTrigger>

                  <SelectContent
                    className="
                      mt-1 bg-grey-100 border border-grey-80 rounded-[8px]
                      shadow-lg overflow-auto z-50 p-0
                    "
                  >
                    <SelectScrollUpButton />
                    <SelectPrimitive.Viewport className="p-0">
                      <SelectGroup>
                        {OPTIONS.map(({ label, value }) => (
                          <SelectPrimitive.Item
                            key={value}
                            value={String(value)}
                            className="
                              relative flex items-center px-4 py-3
                              text-base font-medium text-grey-60 cursor-pointer
                              outline-none
                              data-[highlighted]:bg-grey-90 data-[highlighted]:rounded
                              data-[state=checked]:bg-grey-90 data-[state=checked]:rounded
                              focus-visible:bg-grey-90
                            "
                          >
                            <SelectPrimitive.ItemText>
                              {label}
                            </SelectPrimitive.ItemText>
                          </SelectPrimitive.Item>
                        ))}
                      </SelectGroup>
                    </SelectPrimitive.Viewport>
                    <SelectScrollDownButton />
                  </SelectContent>
                </Select>
              </div>
            </div>
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} className="delay-300">
            <CardButton
              className="max-w-[180px] h-[48px]"
              variant="dialog"
              disabled={loading || saving || !hasChanged}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save"}
            </CardButton>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
}
