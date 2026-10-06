"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Link2, Timer, Volume2 } from "lucide-react";
import { toast } from "sonner";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { RECORD_COUNTDOWN_OPTIONS } from "@/app/capture-overlay/barText";
import { getCaptureOptions, setCaptureOptions, type CaptureOptions } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingsToggle } from "./SettingsToggle";

type Choices = Pick<CaptureOptions, "copyLink" | "openLink" | "recordCountdownSecs" | "systemAudio">;

const COUNTDOWN_OPTIONS = RECORD_COUNTDOWN_OPTIONS.map((t) => ({ value: String(t.secs), label: t.label }));

/**
 * The capture bar's own options that carry over from one capture to the
 * next, offered here as well: copying a share link after a capture,
 * opening it in the browser, the recording countdown and the computer's
 * sound. Rust keeps them (`capture_get_options` / `capture_set_options`,
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
}: {
  rowClassName: string;
  /** Whether this computer records: the recording rows only show where it does. */
  recording: boolean;
  /** Rust's `recordCountdown` surface. */
  recordCountdown: boolean;
  /** Rust's `systemAudio` surface: a recording here can carry the computer's sound. */
  systemAudio: boolean;
}) {
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

  if (!options) return null;

  return (
    <>
      <OptionRow
        rowClassName={rowClassName}
        icon={<Link2 className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />}
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
          icon={<Link2 className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />}
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

      {recording && recordCountdown && (
        <OptionRow
          rowClassName={rowClassName}
          icon={<Timer className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />}
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
          icon={<Volume2 className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />}
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

function OptionRow({
  rowClassName,
  icon,
  title,
  description,
  wide = false,
  children,
}: {
  rowClassName: string;
  icon: ReactNode;
  title: string;
  description: string;
  /** The control takes the row's width on a narrow window (a segmented control). */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={rowClassName}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon}
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">{title}</p>
          <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{description}</p>
        </div>
      </div>
      <div className={wide ? "w-full sm:w-auto" : "flex-shrink-0"}>{children}</div>
    </div>
  );
}
