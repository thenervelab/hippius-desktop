"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, ExternalLink, Image as ImageIcon, Link2, Timer, Volume2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { RECORD_COUNTDOWN_OPTIONS } from "@/app/capture-overlay/barText";
import { getCaptureOptions, setCaptureOptions, type CaptureOptions } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingsToggle } from "./SettingsToggle";
import { SettingIcon } from "./SettingIcon";
import { shareInsightsEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { getSwitchesInPlan } from "@/app/lib/tauri/shareInsights";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { SwitchesUpgradeNotice } from "@/app/components/page-sections/drive/LinkEngagementSwitches";

type Choices = Pick<
  CaptureOptions,
  "copyLink" | "openLink" | "chatPreview" | "linkInsights" | "recordCountdownSecs" | "systemAudio"
>;

const COUNTDOWN_OPTIONS = RECORD_COUNTDOWN_OPTIONS.map((t) => ({ value: String(t.secs), label: t.label }));

const TRACK_TITLE = "Track views, comments and reactions";
/**
 * What tracking shows the owner: how many people viewed and for how long,
 * and a name only for someone who comments under one. Never "who viewed":
 * viewers are not identified.
 */
const TRACK_DESCRIPTION =
  "Links to your screenshots and recordings count how many people view them and for how long, and let viewers comment and react. You see a name only when someone comments under one. You can turn this off for any link.";
/** The tracking card's line on the free plan, where Rust gives new links none of the three. */
export const TRACK_LOCKED_DESCRIPTION =
  "Links to your screenshots and recordings count how many people view them and for how long, and let viewers comment and react. On paid Drive plans.";

/**
 * The capture bar's own options that carry over from one capture to the
 * next, offered here as well: copying a share link after a capture,
 * opening it in the browser, showing a preview in chats, the recording
 * countdown and the computer's sound. Rust keeps them (`capture_get_options` / `capture_set_options`,
 * the same device-wide options the bar's Options menu saves), and snaps
 * every value to what it allows; this only reads and writes them.
 *
 * Each change reads the options fresh before writing them back, so a choice
 * made on the bar meanwhile (a microphone, the camera) is not overwritten.
 */
export default function CaptureOptionsSetting({
  rowClassName,
  recording,
  recordCountdown,
  systemAudio,
  layout = "rows",
}: {
  rowClassName: string;
  /**
   * `cards`: each option a small card in the tab's grid, its icon and
   * control on top and its words below. `rows`: one line per option.
   */
  layout?: "rows" | "cards";
  /** Whether this computer records: the recording rows only show where it does. */
  recording: boolean;
  /** Rust's `recordCountdown` surface. */
  recordCountdown: boolean;
  /** Rust's `systemAudio` surface: a recording here can carry the computer's sound. */
  systemAudio: boolean;
}) {
  const [options, setOptions] = useState<Choices | null>(null);
  // Shown once the server has link Insights; until then the choice would
  // change nothing a user could see.
  const insightsAvailable = useAtomValue(shareInsightsEnabledAtom);
  // Rust's plan answer: `false` (the free plan) shows tracking as a paid
  // feature, since new links get none of the three there; `null` (unread)
  // keeps the plain switch.
  const [switchesInPlan, setSwitchesInPlan] = useState<boolean | null>(null);
  useEffect(() => {
    if (!insightsAvailable) return;
    let alive = true;
    getSwitchesInPlan()
      .then((plan) => alive && setSwitchesInPlan(plan ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [insightsAvailable]);

  useEffect(() => {
    let alive = true;
    getCaptureOptions()
      .then((o) => alive && setOptions(o))
      .catch(() => alive && setOptions(null));
    return () => {
      alive = false;
    };
  }, []);

  const change = async (patch: Partial<Choices>) => {
    const before = options;
    if (before) setOptions({ ...before, ...patch });
    try {
      const fresh = await getCaptureOptions();
      setOptions(await setCaptureOptions({ ...fresh, ...patch }));
    } catch (e) {
      setOptions(before);
      toast.error(errorMessage(e));
    }
  };

  if (!options) return null;

  return (
    <>
      <OptionRow
        rowClassName={rowClassName}
        layout={layout}
        icon={<Link2 className="size-[18px]" strokeWidth={2} />}
        title="Copy a share link after capture"
        description="A public link to each screenshot and recording is put on your clipboard once it is uploaded. Off, captures are only saved to your drive, and you can make a link later."
      >
        <SettingsToggle
          ariaLabel="Copy a share link after capture"
          checked={options.copyLink}
          onCheckedChange={(copyLink) => void change({ copyLink })}
        />
      </OptionRow>

      {/* It opens the link it just copied, so it only means something while links are made. */}
      {options.copyLink && (
        <OptionRow
          rowClassName={rowClassName}
          layout={layout}
          icon={<ExternalLink className="size-[18px]" strokeWidth={2} />}
          title="Open the link in your browser"
          description="Shows the capture in your browser as soon as its link is ready, so you can check it or paste it."
        >
          <SettingsToggle
            ariaLabel="Open the link in your browser"
            checked={options.openLink}
            onCheckedChange={(openLink) => void change({ openLink })}
          />
        </OptionRow>
      )}

      {/* Always shown: besides the links made after a capture, it is where
          the share dialog's preview switch starts for a capture. */}
      <OptionRow
        rowClassName={rowClassName}
        layout={layout}
        icon={<ImageIcon className="size-[18px]" strokeWidth={2} />}
        title="Show a preview in chats"
        description="When you paste a capture's link into a chat, it shows the screenshot or the recording's first frame. The preview picture and file name aren't encrypted."
      >
        <SettingsToggle
          ariaLabel="Show a preview in chats"
          checked={options.chatPreview}
          onCheckedChange={(chatPreview) => void change({ chatPreview })}
        />
      </OptionRow>

      {insightsAvailable && switchesInPlan === false && (
        <LockedTrackingRow rowClassName={rowClassName} layout={layout} />
      )}

      {insightsAvailable && switchesInPlan !== false && (
        <OptionRow
          rowClassName={rowClassName}
          layout={layout}
          icon={<BarChart3 className="size-[18px]" strokeWidth={2} />}
          title={TRACK_TITLE}
          description={TRACK_DESCRIPTION}
        >
          <SettingsToggle
            ariaLabel={TRACK_TITLE}
            checked={options.linkInsights}
            onCheckedChange={(linkInsights) => void change({ linkInsights })}
          />
        </OptionRow>
      )}

      {recording && recordCountdown && (
        <OptionRow
          rowClassName={rowClassName}
          layout={layout}
          icon={<Timer className="size-[18px]" strokeWidth={2} />}
          title="Recording countdown"
          description="How long to wait after you press Record, so you can get ready."
          wide
        >
          <SegmentedControl
            ariaLabel="Recording countdown"
            options={COUNTDOWN_OPTIONS}
            value={String(options.recordCountdownSecs)}
            onChange={(secs) => void change({ recordCountdownSecs: Number(secs) })}
            fullWidth
            showActiveIndicator={false}
          />
        </OptionRow>
      )}

      {recording && systemAudio && (
        <OptionRow
          rowClassName={rowClassName}
          layout={layout}
          icon={<Volume2 className="size-[18px]" strokeWidth={2} />}
          title="Record system audio"
          description="Includes what your computer plays in recordings. With speakers, your voice may be recorded twice; headphones avoid that."
        >
          <SettingsToggle
            ariaLabel="Record system audio"
            checked={options.systemAudio}
            onCheckedChange={(on) => void change({ systemAudio: on })}
          />
        </OptionRow>
      )}
    </>
  );
}

/**
 * "Track views, comments and reactions" on the free plan: a paid feature.
 * The switch shows off, because Rust gives new links none of the three there
 * whatever the stored choice, and turning it on shows the upgrade prompt
 * instead of saving anything.
 */
function LockedTrackingRow({ rowClassName, layout }: { rowClassName: string; layout: "rows" | "cards" }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  return (
    <OptionRow
      rowClassName={rowClassName}
      layout={layout}
      icon={<BarChart3 className="size-[18px]" strokeWidth={2} />}
      title={TRACK_TITLE}
      description={TRACK_LOCKED_DESCRIPTION}
      below={
        <div aria-live="polite">
          {asking && <SwitchesUpgradeNotice onUpgrade={() => router.push(BILLING_ROUTE)} className="mt-3" />}
        </div>
      }
    >
      <SettingsToggle ariaLabel={TRACK_TITLE} checked={false} onCheckedChange={(on) => on && setAsking(true)} />
    </OptionRow>
  );
}

function OptionRow({
  rowClassName,
  layout,
  icon,
  title,
  description,
  wide = false,
  below,
  children,
}: {
  rowClassName: string;
  layout: "rows" | "cards";
  icon: ReactNode;
  title: string;
  description: string;
  /** The control takes the row's width on a narrow window (a segmented control). */
  wide?: boolean;
  /** Under the description (the upgrade prompt). */
  below?: ReactNode;
  children: ReactNode;
}) {
  if (layout === "cards") {
    // A wide control (the countdown's choices) sits under the words; a
    // switch sits in the card's corner, across from its icon.
    return (
      <div className={rowClassName}>
        <div className="flex items-start justify-between gap-3">
          <SettingIcon>{icon}</SettingIcon>
          {!wide && <div className="flex-shrink-0">{children}</div>}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">{title}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-[#7D7D7D] dark:text-grey-dark-600">{description}</p>
          {below}
        </div>
        {wide && <div className="mt-auto w-full">{children}</div>}
      </div>
    );
  }
  return (
    <div className={rowClassName}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex-shrink-0 text-primary-50 dark:text-primary-brand-dark">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">{title}</p>
          <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{description}</p>
          {below}
        </div>
      </div>
      <div className={wide ? "w-full sm:w-auto" : "flex-shrink-0"}>{children}</div>
    </div>
  );
}
