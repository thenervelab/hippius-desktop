"use client";

import { useEffect, useState } from "react";
import { BarChart3, ExternalLink, Image as ImageIcon, Link2, MonitorDown, Timer, Video, Volume2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { RECORD_COUNTDOWN_OPTIONS } from "@/app/capture-overlay/barText";
import { getCaptureOptions, setCaptureOptions, type CaptureOptions } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingsToggle } from "./SettingsToggle";
import { SettingRow } from "./SettingRow";
import { shareInsightsEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { getSwitchesInPlan } from "@/app/lib/tauri/shareInsights";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { SwitchesUpgradeNotice } from "@/app/components/page-sections/drive/LinkEngagementSwitches";

type Choices = Pick<
  CaptureOptions,
  | "copyLink"
  | "openLink"
  | "chatPreview"
  | "linkInsights"
  | "recordCountdownSecs"
  | "systemAudio"
  | "desktopCopy"
  | "desktopCopyRecordings"
>;

const COUNTDOWN_OPTIONS = RECORD_COUNTDOWN_OPTIONS.map((t) => ({ value: String(t.secs), label: t.label }));

const TRACK_TITLE = "Track views, comments and reactions";
/**
 * What tracking shows the owner: how many people viewed and for how long,
 * and a name only for someone who comments under one. Never "who viewed":
 * viewers are not identified.
 */
const TRACK_DESCRIPTION =
  "See how many people view a link and for how long, and let them comment and react. You can turn it off for any link.";
/** The tracking card's line on the free plan, where Rust gives new links none of the three. */
export const TRACK_LOCKED_DESCRIPTION =
  "Links to your screenshots and recordings count how many people view them and for how long, and let viewers comment and react. On paid Drive plans.";

/** The capture options as read from Rust, and the one way to change them. */
export interface CaptureChoices {
  options: Choices | null;
  change: (patch: Partial<Choices>) => Promise<void>;
}

/**
 * The capture bar's own options that carry over from one capture to the
 * next, offered on the Settings tab as well: copying a share link after a
 * capture, opening it, a preview in chats, tracking, a copy on the Desktop,
 * the recording countdown and the computer's sound. Rust keeps them
 * (`capture_get_options` / `capture_set_options`, the same device-wide
 * options the bar's Options menu saves) and snaps every value to what it
 * allows; this only reads and writes them. Read once for the whole tab, so
 * the groups below share one copy.
 *
 * Each change reads the options fresh before writing them back, so a choice
 * made on the bar meanwhile (a microphone, the camera) is not overwritten.
 */
export function useCaptureChoices(): CaptureChoices {
  const [options, setOptions] = useState<Choices | null>(null);

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

  return { options, change };
}

const ICON = "size-[18px]";

/**
 * Saving: a copy on the Desktop, with recordings as a choice of its own
 * under it (videos are large), shown only while copies go there at all.
 */
export function DesktopCopyOptions({ choices, recording }: { choices: CaptureChoices; recording: boolean }) {
  const { options, change } = choices;
  if (!options) return null;
  return (
    <>
      <SettingRow
        icon={<MonitorDown className={ICON} strokeWidth={2} />}
        title="Also save a copy to the Desktop"
        description="Like the system screenshot tool. The capture in your drive and its link stay the same."
        control={
          <SettingsToggle
            ariaLabel="Also save a copy to the Desktop"
            checked={options.desktopCopy === true}
            onCheckedChange={(desktopCopy) => void change({ desktopCopy })}
          />
        }
      />
      {recording && options.desktopCopy === true && (
        <SettingRow
          sub
          icon={<Video className={ICON} strokeWidth={2} />}
          title="Include recordings"
          description="Recordings can be large."
          control={
            <SettingsToggle
              ariaLabel="Save a copy of recordings to the Desktop"
              checked={options.desktopCopyRecordings === true}
              onCheckedChange={(desktopCopyRecordings) => void change({ desktopCopyRecordings })}
            />
          }
        />
      )}
    </>
  );
}

/** Sharing: the link made after a capture, what it opens, and what it shows. */
export function SharingOptions({ choices }: { choices: CaptureChoices }) {
  const { options, change } = choices;
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

  if (!options) return null;
  return (
    <>
      <SettingRow
        icon={<Link2 className={ICON} strokeWidth={2} />}
        title="Copy a share link after capture"
        description="Anyone with the link can view. Off, captures are only saved to your drive."
        control={
          <SettingsToggle
            ariaLabel="Copy a share link after capture"
            checked={options.copyLink}
            onCheckedChange={(copyLink) => void change({ copyLink })}
          />
        }
      />

      {/* It opens the link it just copied, so it only means something while links are made. */}
      {options.copyLink && (
        <SettingRow
          sub
          icon={<ExternalLink className={ICON} strokeWidth={2} />}
          title="Open the link in your browser"
          description="As soon as it's ready, to check it or paste it."
          control={
            <SettingsToggle
              ariaLabel="Open the link in your browser"
              checked={options.openLink}
              onCheckedChange={(openLink) => void change({ openLink })}
            />
          }
        />
      )}

      {/* Always shown: besides the links made after a capture, it is where
          the share dialog's preview switch starts for a capture. */}
      <SettingRow
        icon={<ImageIcon className={ICON} strokeWidth={2} />}
        title="Show a preview in chats"
        description="A pasted link shows the picture. The preview picture and file name aren't encrypted."
        control={
          <SettingsToggle
            ariaLabel="Show a preview in chats"
            checked={options.chatPreview}
            onCheckedChange={(chatPreview) => void change({ chatPreview })}
          />
        }
      />

      {insightsAvailable && switchesInPlan === false && <LockedTrackingRow />}

      {insightsAvailable && switchesInPlan !== false && (
        <SettingRow
          icon={<BarChart3 className={ICON} strokeWidth={2} />}
          title={TRACK_TITLE}
          description={TRACK_DESCRIPTION}
          control={
            <SettingsToggle
              ariaLabel={TRACK_TITLE}
              checked={options.linkInsights}
              onCheckedChange={(linkInsights) => void change({ linkInsights })}
            />
          }
        />
      )}
    </>
  );
}

/** Recording: the countdown before it starts and the computer's own sound. */
export function RecordingOptions({
  choices,
  recordCountdown,
  systemAudio,
}: {
  choices: CaptureChoices;
  /** Rust's `recordCountdown` surface. */
  recordCountdown: boolean;
  /** Rust's `systemAudio` surface: a recording here can carry the computer's sound. */
  systemAudio: boolean;
}) {
  const { options, change } = choices;
  if (!options) return null;
  return (
    <>
      {recordCountdown && (
        <SettingRow
          wide
          icon={<Timer className={ICON} strokeWidth={2} />}
          tone="record"
          title="Countdown"
          description="Time to get ready after you press Record."
          control={
            <SegmentedControl
              ariaLabel="Recording countdown"
              options={COUNTDOWN_OPTIONS}
              value={String(options.recordCountdownSecs)}
              onChange={(secs) => void change({ recordCountdownSecs: Number(secs) })}
              fullWidth
              showActiveIndicator={false}
            />
          }
        />
      )}
      {systemAudio && (
        <SettingRow
          icon={<Volume2 className={ICON} strokeWidth={2} />}
          tone="record"
          title="Record system audio"
          description="What your computer plays. Use headphones so your voice isn't recorded twice."
          control={
            <SettingsToggle
              ariaLabel="Record system audio"
              checked={options.systemAudio}
              onCheckedChange={(on) => void change({ systemAudio: on })}
            />
          }
        />
      )}
    </>
  );
}

/**
 * Every capture option in one list, for a surface without the tab's
 * groups (the e2e settings scene).
 */
export default function CaptureOptionsSetting({
  recording,
  recordCountdown,
  systemAudio,
}: {
  /** Whether this computer records: the recording rows only show where it does. */
  recording: boolean;
  recordCountdown: boolean;
  systemAudio: boolean;
}) {
  const choices = useCaptureChoices();
  return (
    <div className="divide-y divide-grey-dark-100 dark:divide-black-300">
      <SharingOptions choices={choices} />
      <DesktopCopyOptions choices={choices} recording={recording} />
      {recording && <RecordingOptions choices={choices} recordCountdown={recordCountdown} systemAudio={systemAudio} />}
    </div>
  );
}

/**
 * "Track views, comments and reactions" on the free plan: a paid feature.
 * The switch shows off, because Rust gives new links none of the three there
 * whatever the stored choice, and turning it on shows the upgrade prompt
 * instead of saving anything.
 */
function LockedTrackingRow() {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  return (
    <SettingRow
      icon={<BarChart3 className={ICON} strokeWidth={2} />}
      title={TRACK_TITLE}
      description={TRACK_LOCKED_DESCRIPTION}
      below={
        <div aria-live="polite">
          {asking && <SwitchesUpgradeNotice onUpgrade={() => router.push(BILLING_ROUTE)} className="mt-3" />}
        </div>
      }
      control={<SettingsToggle ariaLabel={TRACK_TITLE} checked={false} onCheckedChange={(on) => on && setAsking(true)} />}
    />
  );
}
