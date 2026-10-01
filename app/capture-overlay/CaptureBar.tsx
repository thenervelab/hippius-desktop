"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, LayoutGrid, Mic, MicOff, Monitor, MonitorOff, Video, VideoOff, X } from "lucide-react";
import {
  getCaptureCameras,
  getCaptureDestinationChoices,
  getCaptureMicrophones,
  saveCaptureOptions,
  setCaptureDestination,
  type CaptureDestination,
  type CaptureDestinationChoice,
  type CaptureDevice,
  type CaptureKind,
  type CaptureMode,
  type CaptureOptions,
  type CaptureSavedOptions,
  type ShareTab,
} from "@/app/lib/tauri/capture";
import { MODE_ICON } from "@/app/lib/capture/modes";
import { GLASS_BAR, GLASS_BUTTON, GLASS_FOCUS, GLASS_MUTED, GLASS_PANEL, GLASS_PRIMARY } from "@/app/lib/capture/glass";
import {
  barGroups,
  CAMERA_NOT_FILMED,
  chooseLabel,
  confirmLabel,
  isDeviceInUse,
  pickCamera,
  pickMicrophone,
  RECORD_COUNTDOWN_OPTIONS,
  shareTabFor,
  sourceLabel,
  TIMER_OPTIONS,
  toggleScreen,
  type BarMode,
  type OfferedModes,
} from "./barText";
import { stepIndex } from "./keyNav";
import MicMeter from "./MicMeter";

/**
 * The capture bar: the macOS ⌘⇧5-style toolbar at the bottom of the display
 * the pointer was on. Six modes, an Options menu and the Capture / Record
 * button. It draws and reports; Rust decides what each choice means.
 *
 * Dark glass whatever the app's theme, as macOS draws its own: it sits over
 * other apps' windows, not over Hippius.
 *
 * Keyboard: the modes are two radio groups (arrows move and pick), and a
 * menu, while open, owns the keyboard: Escape closes only the menu and puts
 * focus back on the button that opened it, arrows and Home / End move
 * through its items, and Return never reaches the page's "take the capture".
 */

type OpenMenu = "options" | "camera" | "microphone";

const MENU_ITEMS = '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]';

function ModeGroup({
  entries,
  label,
  isActive,
  onPick,
}: {
  entries: BarMode[];
  label: string;
  isActive: (entry: BarMode) => boolean;
  onPick: (entry: BarMode) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = entries.findIndex(isActive);
  // Roving focus: one stop per group, on the chosen mode (else the first).
  const tabStop = active < 0 ? 0 : active;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = refs.current.findIndex((el) => el === document.activeElement);
    const next = stepIndex(e.key, at, entries.length, "both");
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    // A disabled mode takes focus (so its reason is read) but is not picked.
    if (!entries[next].unavailable) onPick(entries[next]);
  };

  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5" onKeyDown={onKeyDown}>
      {entries.map((entry, i) => {
        const Icon = MODE_ICON[entry.mode];
        const checked = i === active;
        return (
          <button
            key={`${entry.kind}-${entry.mode}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={entry.label}
            // aria-disabled, not disabled: a disabled button gets no hover,
            // so its tooltip would never say why. A click puts the reason on
            // the hint line, which is a live region.
            aria-disabled={entry.unavailable ? true : undefined}
            title={entry.unavailable ? `${entry.label}: ${entry.unavailable}` : entry.label}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onPick(entry)}
            className={`relative grid h-9 w-10 place-items-center rounded-[8px] transition-colors ${GLASS_FOCUS} ${
              entry.unavailable
                ? "cursor-default text-white/40"
                : checked
                  ? "bg-white/20 text-white"
                  : "text-white/80 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon className="size-[18px]" strokeWidth={1.8} />
            {entry.kind === "recording" && (
              // A soft halo in the glass's own colour, not an opaque ring,
              // so no dark rim shows around the dot over a light desktop.
              <span
                aria-hidden
                className={`absolute bottom-[7px] right-[8px] size-[7px] rounded-full shadow-[0_0_0_2px_rgba(28,29,33,0.85)] ${
                  entry.unavailable ? "bg-white/40" : "bg-[#FF453A]"
                }`}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className={`px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] ${GLASS_MUTED}`}>{children}</p>
  );
}

function MenuRow({
  checked,
  onSelect,
  role,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  role: "menuitemradio" | "menuitemcheckbox";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      tabIndex={-1}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-white/90 hover:bg-white/10 focus-visible:bg-white/10 ${GLASS_FOCUS}`}
    >
      <span className="grid size-4 place-items-center">{checked && <Check className="size-3.5" />}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function OptionsMenu({
  menuRef,
  kind,
  options,
  destination,
  showClicksAvailable,
  screenshotTimer,
  systemAudioAvailable,
  onOptions,
  onDestination,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  kind: CaptureKind;
  options: CaptureOptions;
  destination: CaptureDestination | null;
  showClicksAvailable: boolean;
  /** Whether this platform offers the screenshot timer (Rust's `screenshotTimer`). */
  screenshotTimer: boolean;
  /** Whether a recording here can carry the computer's sound (Rust's `systemAudio`). */
  systemAudioAvailable: boolean;
  onOptions: (next: CaptureOptions) => void;
  onDestination: (next: CaptureDestination) => void;
}) {
  const [choices, setChoices] = useState<CaptureDestinationChoice[] | null>(null);

  useEffect(() => {
    getCaptureDestinationChoices()
      .then(setChoices)
      .catch(() => setChoices([]));
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Capture options"
      className={`absolute bottom-[calc(100%+10px)] right-0 max-h-[60vh] w-64 overflow-y-auto rounded-[12px] p-1.5 ${GLASS_PANEL}`}
    >
      <MenuHeading>Save to</MenuHeading>
      {choices === null ? (
        <p className={`px-2.5 py-1.5 text-[13px] ${GLASS_MUTED}`}>Loading drives…</p>
      ) : choices.length === 0 ? (
        <p className={`px-2.5 py-1.5 text-[13px] ${GLASS_MUTED}`}>{destination?.displayName ?? "No drives found"}</p>
      ) : (
        choices.map((c) => (
          <MenuRow
            key={c.label}
            role="menuitemradio"
            checked={destination?.label === c.label}
            onSelect={() => onDestination({ label: c.label, displayName: c.label })}
          >
            {c.label}
            <span className={`ml-1.5 ${GLASS_MUTED}`}>› Captures</span>
          </MenuRow>
        ))
      )}

      {kind === "screenshot" ? (
        screenshotTimer && (
          <>
            <MenuHeading>Timer</MenuHeading>
          {TIMER_OPTIONS.map((t) => (
            <MenuRow
              key={t.secs}
              role="menuitemradio"
              checked={options.timerSecs === t.secs}
              onSelect={() => onOptions({ ...options, timerSecs: t.secs })}
            >
              {t.label}
            </MenuRow>
          ))}
          </>
        )
      ) : (
        <>
          <MenuHeading>Recording countdown</MenuHeading>
          {RECORD_COUNTDOWN_OPTIONS.map((t) => (
            <MenuRow
              key={t.secs}
              role="menuitemradio"
              checked={options.recordCountdownSecs === t.secs}
              onSelect={() => onOptions({ ...options, recordCountdownSecs: t.secs })}
            >
              {t.label}
            </MenuRow>
          ))}
          <MenuHeading>Recording</MenuHeading>
          {/* Off by default, as in Loom: with speakers it records the voice twice. */}
          {systemAudioAvailable && (
            <MenuRow
              role="menuitemcheckbox"
              checked={options.systemAudio}
              onSelect={() => onOptions({ ...options, systemAudio: !options.systemAudio })}
            >
              Record system audio
            </MenuRow>
          )}
          {showClicksAvailable && (
            <MenuRow
              role="menuitemcheckbox"
              checked={options.showClicks}
              onSelect={() => onOptions({ ...options, showClicks: !options.showClicks })}
            >
              Show mouse clicks
            </MenuRow>
          )}
        </>
      )}

      <MenuHeading>After capture</MenuHeading>
      <MenuRow
        role="menuitemcheckbox"
        checked={options.copyLink}
        onSelect={() => onOptions({ ...options, copyLink: !options.copyLink })}
      >
        Copy a share link after capture
      </MenuRow>
    </div>
  );
}

/**
 * An on/off switch, macOS style, on the right of a source row. The track is
 * 18 pt tall; the button around it is 24 pt so it is easy to hit.
 */
function Switch({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`grid h-6 w-9 shrink-0 place-items-center rounded-full disabled:cursor-not-allowed disabled:opacity-45 ${GLASS_FOCUS}`}
    >
      <span
        aria-hidden
        className={`relative h-[18px] w-[30px] rounded-full transition-colors motion-reduce:transition-none ${
          on ? "bg-[#30D158]" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left] motion-reduce:transition-none ${
            on ? "left-[14px]" : "left-[2px]"
          }`}
        />
      </span>
    </button>
  );
}

/**
 * One source row, Loom style: an icon, what is in use (a device menu for the
 * camera and microphone), and a switch. The switch is the on/off; the menu
 * only chooses which device, and picking one turns the source on. A caption
 * under the row says what an off or unavailable source means.
 */
function SourceRow({
  icon: Icon,
  label,
  switchLabel,
  on,
  caption,
  menuLabel,
  devices,
  loading,
  hint,
  chosen,
  open,
  disabled,
  extra,
  triggerRef,
  menuRef,
  onOpen,
  onPick,
  onToggle,
}: {
  icon: typeof Monitor;
  label: string;
  /** The switch's name; the row's own name when left out. */
  switchLabel?: string;
  on: boolean;
  caption?: string | null;
  /** The device menu's name; no menu for a row without devices (Screen). */
  menuLabel?: string;
  /** Null until the first list arrives (the menu shows placeholders). */
  devices?: CaptureDevice[] | null;
  /** A list is being read: a placeholder row says more may arrive. */
  loading?: boolean;
  /** Rust's line on bringing an iPhone in, shown when no listed device is one. */
  hint?: string | null;
  chosen?: string | null;
  open?: boolean;
  disabled?: boolean;
  extra?: React.ReactNode;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  onOpen?: () => void;
  onPick?: (deviceId: string) => void;
  onToggle: () => void;
}) {
  const hasMenu = !!menuLabel && !!onOpen;
  const noun = (menuLabel ?? label).toLowerCase();
  const lit = on && !disabled;
  return (
    <div className="relative px-2.5 py-1">
      <div className="flex items-center gap-2.5">
        <Icon aria-hidden className={`size-4 shrink-0 ${lit ? "text-white" : "text-white/45"}`} />
        {hasMenu ? (
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`${menuLabel}: ${label}`}
            disabled={disabled}
            onClick={onOpen}
            className={`flex min-h-6 min-w-0 flex-1 items-center gap-1 rounded-[6px] px-1 py-0.5 text-left text-[12.5px] hover:bg-white/10 disabled:cursor-not-allowed disabled:hover:bg-transparent ${GLASS_FOCUS} ${
              lit ? "text-white" : "text-white/60"
            }`}
          >
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
          </button>
        ) : (
          <span className={`min-w-0 flex-1 truncate px-1 text-[12.5px] ${lit ? "text-white" : "text-white/60"}`}>{label}</span>
        )}
        {extra}
        <Switch on={lit} label={switchLabel ?? menuLabel ?? label} disabled={disabled} onToggle={onToggle} />
      </div>
      {caption && <p className={`pb-0.5 pl-[26px] text-[11.5px] leading-snug ${GLASS_MUTED}`}>{caption}</p>}
      {open && devices !== undefined && onPick && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Choose a ${noun}`}
          aria-busy={loading || devices === null}
          className={`absolute bottom-[calc(100%+6px)] left-2 right-2 z-10 max-h-[50vh] overflow-y-auto rounded-[12px] p-1.5 ${GLASS_PANEL}`}
        >
          {devices === null ? (
            <>
              <DeviceSkeleton />
              <DeviceSkeleton short />
            </>
          ) : devices.length === 0 && !loading ? (
            <p className={`px-2.5 py-1.5 text-[13px] ${GLASS_MUTED}`}>Only the default {noun} was found</p>
          ) : (
            devices.map((d) => (
              <MenuRow
                key={d.id}
                role="menuitemradio"
                checked={on && isDeviceInUse(d, chosen ?? null, devices)}
                onSelect={() => onPick(d.id)}
              >
                {d.name}
                {d.isDefault && <span className={`ml-1.5 ${GLASS_MUTED}`}>Default</span>}
              </MenuRow>
            ))
          )}
          {devices !== null && loading && <DeviceSkeleton short />}
          <span role="status" className="sr-only">
            {loading || devices === null ? `Looking for ${noun}s` : ""}
          </span>
          {hint && devices !== null && !devices.some((d) => d.continuity) && (
            <p className={`mt-1 border-t border-white/10 px-2.5 pb-1 pt-2 text-[11.5px] leading-snug ${GLASS_MUTED}`}>
              {hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A device row still being looked for: a placeholder bar, never a spinner. */
function DeviceSkeleton({ short = false }: { short?: boolean }) {
  return (
    <div aria-hidden data-device-skeleton className="flex min-h-8 items-center px-2.5">
      <span
        className={`h-2.5 rounded-full bg-white/15 animate-pulse motion-reduce:animate-none ${short ? "w-2/5" : "w-3/5"}`}
      />
    </div>
  );
}

/**
 * One of the bar's device lists: null until the first read answers, read
 * again on demand (`refresh`), and replaced whenever Rust sends a new one on
 * `event` (its device watcher, while the bar is up). `loading` while any read
 * is in flight, so the menu can say more devices may still arrive.
 */
function useDeviceList(read: () => Promise<CaptureDevice[]>, event: string, enabled: boolean) {
  const [devices, setDevices] = useState<CaptureDevice[] | null>(null);
  const [reading, setReading] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    setReading((n) => n + 1);
    void read()
      .then(setDevices)
      .catch(() => setDevices((prev) => prev ?? []))
      .finally(() => setReading((n) => n - 1));
  }, [read, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const unlisten = listen<CaptureDevice[]>(event, (e) => setDevices(e.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [event, enabled]);
  return { devices, loading: reading > 0, refresh };
}

/**
 * The recording sources above the bar, Loom style: one row each for the
 * screen, the camera and the microphone, with a switch to turn each on or
 * off and a menu to pick the device. Each change is saved at once, so the
 * camera appears as soon as it is turned on and can be placed before
 * recording. The lists are read again whenever a menu opens, so a device
 * plugged in since shows up.
 */
function SourcesPanel({
  options,
  microphoneAvailable,
  microphoneUnavailableMessage,
  continuityHint,
  cameraOnlyAvailable,
  cameraFilmed,
  menu,
  cameraTrigger,
  microphoneTrigger,
  menuRef,
  onMenu,
  onOptions,
}: {
  options: CaptureOptions;
  microphoneAvailable: boolean;
  /** Rust's line for why the microphone is off here; shown under the dimmed row. */
  microphoneUnavailableMessage: string | null;
  /** Rust's iPhone checklist, under a device menu that lists no iPhone; null where it does not apply. */
  continuityHint: string | null;
  /** The Screen switch (off = camera only) is offered only where Rust can record the camera alone. */
  cameraOnlyAvailable: boolean;
  /** Whether the camera would be in the video for the mode chosen now (Rust's answer). */
  cameraFilmed: boolean;
  menu: OpenMenu | null;
  cameraTrigger: React.RefObject<HTMLButtonElement | null>;
  microphoneTrigger: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onMenu: (next: OpenMenu | null) => void;
  onOptions: (next: CaptureOptions) => void;
}) {
  // Rust sends a new list whenever a device comes or goes while the bar is
  // up (a USB mic plugged in, an iPhone's camera and then its microphone
  // arriving), and the camera window reports what it finds where the system
  // has no list.
  const camerasList = useDeviceList(getCaptureCameras, "capture_cameras", true);
  const microphonesList = useDeviceList(getCaptureMicrophones, "capture_microphones", microphoneAvailable);
  const readCameras = camerasList.refresh;
  const readMicrophones = microphonesList.refresh;
  const cameras = camerasList.devices ?? [];
  const microphones = microphonesList.devices ?? [];

  useEffect(() => {
    readCameras();
  }, [readCameras]);

  useEffect(() => {
    readMicrophones();
  }, [readMicrophones]);

  // The webview's own signal, where it sends one (WebKit does so only once
  // the page holds a capture grant): read both lists again.
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChange = () => {
      readCameras();
      readMicrophones();
    };
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [readCameras, readMicrophones]);

  const toggleMenu = (which: "camera" | "microphone") => {
    onMenu(menu === which ? null : which);
    if (which === "camera") readCameras();
    else readMicrophones();
  };

  const pick = (next: CaptureOptions) => {
    onMenu(null);
    onOptions(next);
  };

  const micOn = options.microphone && microphoneAvailable;

  return (
    <div role="group" aria-label="Recording sources" className={`w-[300px] max-w-[calc(100vw-32px)] rounded-[14px] p-1 ${GLASS_BAR}`}>
      {cameraOnlyAvailable && (
        <SourceRow
          icon={options.screen ? Monitor : MonitorOff}
          label="Screen"
          on={options.screen}
          caption={options.screen ? null : "Recording the camera only"}
          onToggle={() => pick(toggleScreen(options))}
        />
      )}
      <SourceRow
        icon={options.camera ? Video : VideoOff}
        label={sourceLabel(options.camera, options.cameraDevice, cameras, "camera")}
        menuLabel="Camera"
        on={options.camera}
        caption={cameraFilmed ? null : CAMERA_NOT_FILMED}
        devices={camerasList.devices}
        loading={camerasList.loading}
        hint={continuityHint}
        chosen={options.cameraDevice}
        open={menu === "camera"}
        triggerRef={cameraTrigger}
        menuRef={menuRef}
        onOpen={() => toggleMenu("camera")}
        onPick={(id) => pick(pickCamera(options, id))}
        onToggle={() => pick(pickCamera(options, options.camera ? null : (options.cameraDevice ?? "default")))}
      />
      <SourceRow
        icon={micOn ? Mic : MicOff}
        label={sourceLabel(micOn, options.microphoneDevice, microphones, "microphone")}
        menuLabel="Microphone"
        on={options.microphone}
        caption={microphoneAvailable ? null : microphoneUnavailableMessage}
        devices={microphonesList.devices}
        loading={microphonesList.loading}
        hint={continuityHint}
        chosen={options.microphoneDevice}
        open={menu === "microphone"}
        disabled={!microphoneAvailable}
        triggerRef={microphoneTrigger}
        menuRef={menuRef}
        extra={micOn ? <MicMeter deviceId={options.microphoneDevice} /> : null}
        onOpen={() => toggleMenu("microphone")}
        onPick={(id) => pick(pickMicrophone(options, id))}
        onToggle={() =>
          pick(pickMicrophone(options, options.microphone ? null : (options.microphoneDevice ?? "default")))
        }
      />
    </div>
  );
}

interface Props {
  kind: CaptureKind;
  mode: CaptureMode;
  options: CaptureOptions;
  destination: CaptureDestination | null;
  recordingAvailable: boolean;
  /** Why the Record modes are shown disabled (`disabledRecordingNote`); null shows them normally or not at all. */
  recordingNote?: string | null;
  microphoneAvailable: boolean;
  /** Rust's line for why the microphone is off here (`microphoneUnavailableMessage`). */
  microphoneUnavailableMessage?: string | null;
  /** Rust's iPhone checklist for the device menus (`continuityHint`); none when left out. */
  continuityHint?: string | null;
  showClicksAvailable: boolean;
  /** The modes each kind may offer (Rust's `modes`); every mode when left out. */
  modes?: OfferedModes;
  /** Whether the screenshot timer is offered (Rust's `screenshotTimer`); offered when left out. */
  screenshotTimer?: boolean;
  /** Whether "Record system audio" is offered (Rust's `systemAudio`); offered when left out. */
  systemAudioAvailable?: boolean;
  /** Camera only (the Screen switch) can be recorded here. */
  cameraOnlyAvailable: boolean;
  /** Whether the camera, if on, is in the video for this mode. */
  cameraFilmed: boolean;
  hint: string;
  /** "Return" on a Mac, "Enter" elsewhere, for the hint and the tooltips. */
  enterKey?: string;
  /** Recording the camera alone: no area, window or screen to choose. */
  cameraOnly: boolean;
  onMode: (kind: CaptureKind, mode: CaptureMode) => void;
  /** Open "Choose what to share" on this tab. */
  onChoose: (tab: ShareTab) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** What Rust stored, with the countdown and whether the camera is filmed for the mode chosen now. */
  onOptionsSaved: (saved: CaptureSavedOptions) => void;
  onDestinationSaved: (destination: CaptureDestination) => void;
}

export default function CaptureBar(props: Props) {
  const { kind, mode, options, destination, hint } = props;
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // Why a disabled mode cannot be picked, shown in place of the hint once one is clicked.
  const [modeNote, setModeNote] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionsTrigger = useRef<HTMLButtonElement | null>(null);
  const cameraTrigger = useRef<HTMLButtonElement | null>(null);
  const microphoneTrigger = useRef<HTMLButtonElement | null>(null);

  const triggerFor = useCallback(
    (which: OpenMenu) =>
      which === "options" ? optionsTrigger.current : which === "camera" ? cameraTrigger.current : microphoneTrigger.current,
    [],
  );

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      if (returnFocus && menu) triggerFor(menu)?.focus();
      setMenu(null);
    },
    [menu, triggerFor],
  );

  // An open menu: focus its chosen item (or its first), so the keyboard can
  // carry on from there. A click that opened it leaves no visible ring.
  useEffect(() => {
    if (!menu) return;
    const list = menuRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(MENU_ITEMS));
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [menu]);

  // While a menu is open it owns the keyboard, whatever has focus (a click
  // does not focus a button in WebKit, so focus may still be on the page).
  // Capture phase on the window, ahead of the overlay page's own handler.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
        return;
      }
      if (e.key === "Tab") {
        closeMenu(false);
        return;
      }
      const items = menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>(MENU_ITEMS)) : [];
      const next = stepIndex(e.key, items.indexOf(document.activeElement as HTMLElement), items.length, "vertical");
      if (next !== null) {
        e.preventDefault();
        e.stopPropagation();
        items[next]?.focus();
        return;
      }
      // Return picks the focused item (the button's own default action) and
      // never also takes the capture.
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu, closeMenu]);

  // A click anywhere outside the open menu closes it, as a menu does. Its
  // own trigger toggles it instead.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerFor(menu)?.contains(target)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [menu, triggerFor]);

  const saveOptions = (next: CaptureOptions) => {
    saveCaptureOptions(next)
      .then(props.onOptionsSaved)
      .catch(() => undefined);
  };
  const saveDestination = (next: CaptureDestination) => {
    setCaptureDestination(next)
      .then(() => props.onDestinationSaved(next))
      .catch(() => undefined);
  };

  const groups = barGroups(props.recordingAvailable, props.recordingNote ?? null, props.modes);
  const isActive = (entry: BarMode) =>
    entry.kind === kind && entry.mode === mode && !(props.cameraOnly && entry.kind === "recording");
  const pickMode = (entry: BarMode) => {
    // A disabled Record mode puts its reason on the hint line, where it is
    // read out, instead of switching.
    if (entry.unavailable) {
      setModeNote(entry.unavailable);
      return;
    }
    setModeNote(null);
    // Picking what to record brings the screen back.
    if (props.cameraOnly && entry.kind === "recording") saveOptions({ ...options, screen: true });
    props.onMode(entry.kind, entry.mode);
  };

  return (
    <div
      data-capture-bar
      className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5"
      // The bar is a control, not part of the selection surface under it.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* Polite: a refusal ("Drag to choose an area first") replaces the
          hint, and a screen reader should hear it. */}
      <p role="status" aria-live="polite" className="rounded-full bg-[#000]/70 px-3.5 py-1.5 text-[13px] text-white/90 shadow-lg">
        {modeNote ?? hint}
      </p>
      {kind === "recording" && (
        <SourcesPanel
          options={options}
          microphoneAvailable={props.microphoneAvailable}
          microphoneUnavailableMessage={props.microphoneUnavailableMessage ?? null}
          continuityHint={props.continuityHint ?? null}
          cameraOnlyAvailable={props.cameraOnlyAvailable}
          cameraFilmed={props.cameraFilmed}
          menu={menu}
          cameraTrigger={cameraTrigger}
          microphoneTrigger={microphoneTrigger}
          menuRef={menuRef}
          onMenu={setMenu}
          onOptions={saveOptions}
        />
      )}
      <div role="toolbar" aria-label="Capture" className={`flex items-center gap-1 rounded-[14px] p-1.5 ${GLASS_BAR}`}>
        <button
          type="button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={props.onCancel}
          className={`grid size-7 place-items-center rounded-full ${GLASS_BUTTON}`}
        >
          <X aria-hidden className="size-4" />
        </button>
        {groups.map((group) => (
          <div key={group[0].kind} className="flex items-center">
            <span aria-hidden className="mx-1.5 h-6 w-px bg-white/15" />
            <ModeGroup
              entries={group}
              label={group[0].kind === "recording" ? "Record" : "Screenshot"}
              isActive={isActive}
              onPick={pickMode}
            />
          </div>
        ))}
        <span aria-hidden className="mx-1.5 h-6 w-px bg-white/15" />
        {!props.cameraOnly && (
          <button
            type="button"
            aria-haspopup="dialog"
            title="Pick a window or screen from a list"
            onClick={() => {
              setMenu(null);
              props.onChoose(shareTabFor(mode));
            }}
            className={`flex h-9 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] ${GLASS_BUTTON}`}
          >
            <LayoutGrid aria-hidden className="size-3.5" />
            {chooseLabel(mode)}
          </button>
        )}
        <div className="relative">
          <button
            ref={optionsTrigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu === "options"}
            onClick={() => setMenu((m) => (m === "options" ? null : "options"))}
            className={`flex h-9 items-center gap-1 rounded-[8px] px-2.5 text-[13px] ${GLASS_BUTTON}`}
          >
            Options
            <ChevronDown aria-hidden className="size-3.5" />
          </button>
          {menu === "options" && (
            <OptionsMenu
              menuRef={menuRef}
              kind={kind}
              options={options}
              destination={destination}
              showClicksAvailable={props.showClicksAvailable}
              screenshotTimer={props.screenshotTimer ?? true}
              systemAudioAvailable={props.systemAudioAvailable ?? true}
              onOptions={saveOptions}
              onDestination={saveDestination}
            />
          )}
        </div>
        <button
          type="button"
          onClick={props.onConfirm}
          title={`${confirmLabel(kind)} (${props.enterKey ?? "Return"})`}
          className={`ml-1 h-9 rounded-[9px] px-4 text-[13px] shadow-[0_1px_0_rgba(255,255,255,0.15)_inset] ${GLASS_PRIMARY}`}
        >
          {confirmLabel(kind)}
        </button>
      </div>
    </div>
  );
}
