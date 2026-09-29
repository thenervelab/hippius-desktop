"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, Check, ChevronDown, LayoutGrid, Mic, MicOff, Monitor, MonitorOff, SquareDashed, Video, VideoOff, X } from "lucide-react";
import {
  getCaptureCameras,
  getCaptureDestinationChoices,
  getCaptureMicrophones,
  setCaptureDestination,
  setCaptureOptions,
  type CaptureDestination,
  type CaptureDestinationChoice,
  type CaptureDevice,
  type CaptureKind,
  type CaptureMode,
  type CaptureOptions,
  type ShareTab,
} from "@/app/lib/tauri/capture";
import {
  barGroups,
  confirmLabel,
  isDeviceInUse,
  pickCamera,
  pickMicrophone,
  shareTabFor,
  sourceLabel,
  TIMER_OPTIONS,
  toggleScreen,
  type BarMode,
} from "./barText";
import MicMeter from "./MicMeter";

/**
 * The capture bar: the macOS ⌘⇧5-style toolbar at the bottom of the display
 * the pointer was on. Six modes, an Options menu and the Capture / Record
 * button. It draws and reports; Rust decides what each choice means.
 *
 * Dark glass whatever the app's theme, as macOS draws its own: it sits over
 * other apps' windows, not over Hippius.
 */

const MODE_ICON = { screen: Monitor, window: AppWindow, area: SquareDashed } as const;

function ModeButton({ entry, active, onPick }: { entry: BarMode; active: boolean; onPick: () => void }) {
  const Icon = MODE_ICON[entry.mode];
  return (
    <button
      type="button"
      aria-label={entry.label}
      aria-pressed={active}
      title={entry.label}
      onClick={onPick}
      className={`relative grid h-9 w-10 place-items-center rounded-[8px] transition-colors ${
        active ? "bg-white/20 text-white" : "text-white/80 hover:bg-white/10 hover:text-white"
      }`}
    >
      <Icon className="size-[18px]" strokeWidth={1.8} />
      {entry.kind === "recording" && (
        <span aria-hidden className="absolute bottom-[7px] right-[8px] size-[7px] rounded-full bg-[#FF453A] ring-2 ring-[#1c1d21]" />
      )}
    </button>
  );
}

interface OptionsMenuProps {
  kind: CaptureKind;
  options: CaptureOptions;
  destination: CaptureDestination | null;
  showClicksAvailable: boolean;
  onOptions: (next: CaptureOptions) => void;
  onDestination: (next: CaptureDestination) => void;
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-white/45">{children}</p>;
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
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-white/90 hover:bg-white/10"
    >
      <span className="grid size-4 place-items-center">{checked && <Check className="size-3.5" />}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function OptionsMenu({
  kind,
  options,
  destination,
  showClicksAvailable,
  onOptions,
  onDestination,
}: OptionsMenuProps) {
  const [choices, setChoices] = useState<CaptureDestinationChoice[] | null>(null);

  useEffect(() => {
    getCaptureDestinationChoices()
      .then(setChoices)
      .catch(() => setChoices([]));
  }, []);

  return (
    <div
      role="menu"
      aria-label="Capture options"
      className="absolute bottom-[calc(100%+10px)] right-0 max-h-[60vh] w-64 overflow-y-auto rounded-[12px] border border-white/10 bg-[#1c1d21]/95 p-1.5 shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
    >
      <MenuHeading>Save to</MenuHeading>
      {choices === null ? (
        <p className="px-2.5 py-1.5 text-[13px] text-white/50">Loading drives…</p>
      ) : choices.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[13px] text-white/50">{destination?.displayName ?? "No drives found"}</p>
      ) : (
        choices.map((c) => (
          <MenuRow
            key={c.label}
            role="menuitemradio"
            checked={destination?.label === c.label}
            onSelect={() => onDestination({ label: c.label, displayName: c.label })}
          >
            {c.label}
            <span className="ml-1.5 text-white/40">› Captures</span>
          </MenuRow>
        ))
      )}

      {kind === "screenshot" ? (
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
      ) : (
        <>
          <MenuHeading>Recording</MenuHeading>
          {showClicksAvailable && (
            <MenuRow
              role="menuitemcheckbox"
              checked={options.showClicks}
              onSelect={() => onOptions({ ...options, showClicks: !options.showClicks })}
            >
              Show mouse clicks
            </MenuRow>
          )}
          <p className="px-2.5 pb-1 pt-1.5 text-[12px] leading-snug text-white/45">
            Camera, microphone and screen are chosen above the bar. Recording starts after a 3 second countdown.
          </p>
        </>
      )}
    </div>
  );
}

type SourceMenu = "camera" | "microphone";

/** An on/off switch, macOS style, on the right of a source row. */
function Switch({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        on ? "bg-[#30D158]" : "bg-white/20"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left] ${on ? "left-[14px]" : "left-[2px]"}`}
      />
    </button>
  );
}

/**
 * One source row, Loom style: an icon, what is in use (a device menu for the
 * camera and microphone), and a switch. The switch is the on/off; the menu
 * only chooses which device, and picking one turns the source on.
 */
function SourceRow({
  icon: Icon,
  label,
  on,
  menuLabel,
  devices,
  chosen,
  open,
  disabled,
  disabledReason,
  extra,
  onOpen,
  onPick,
  onToggle,
}: {
  icon: typeof Monitor;
  label: string;
  on: boolean;
  /** The device menu's name; no menu for a row without devices (Screen). */
  menuLabel?: string;
  devices?: CaptureDevice[];
  chosen?: string | null;
  open?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  extra?: React.ReactNode;
  onOpen?: () => void;
  onPick?: (deviceId: string) => void;
  onToggle: () => void;
}) {
  const hasMenu = !!menuLabel && !!onOpen;
  const noun = (menuLabel ?? label).toLowerCase();
  return (
    <div className="relative flex items-center gap-2.5 px-2.5 py-1.5" title={disabled ? disabledReason : undefined}>
      <Icon className={`size-4 shrink-0 ${on && !disabled ? "text-white" : "text-white/45"}`} />
      {hasMenu ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${menuLabel}: ${label}`}
          disabled={disabled}
          onClick={onOpen}
          className={`flex min-w-0 flex-1 items-center gap-1 rounded-[6px] px-1 py-0.5 text-left text-[12.5px] hover:bg-white/10 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
            on && !disabled ? "text-white" : "text-white/55"
          }`}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      ) : (
        <span className={`min-w-0 flex-1 truncate px-1 text-[12.5px] ${on ? "text-white" : "text-white/55"}`}>{label}</span>
      )}
      {extra}
      <Switch on={on && !disabled} label={menuLabel ?? label} disabled={disabled} onToggle={onToggle} />
      {open && devices && onPick && (
        <div
          role="menu"
          aria-label={`Choose a ${noun}`}
          className="absolute bottom-[calc(100%+6px)] left-2 right-2 z-10 max-h-[50vh] overflow-y-auto rounded-[12px] border border-white/10 bg-[#1c1d21]/95 p-1.5 shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          {devices.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[13px] text-white/50">Only the default {noun} was found</p>
          ) : (
            devices.map((d) => (
              <MenuRow
                key={d.id}
                role="menuitemradio"
                checked={on && isDeviceInUse(d, chosen ?? null, devices)}
                onSelect={() => onPick(d.id)}
              >
                {d.name}
                {d.isDefault && <span className="ml-1.5 text-white/40">Default</span>}
              </MenuRow>
            ))
          )}
        </div>
      )}
    </div>
  );
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
  onOptions,
}: {
  options: CaptureOptions;
  microphoneAvailable: boolean;
  onOptions: (next: CaptureOptions) => void;
}) {
  const [menu, setMenu] = useState<SourceMenu | null>(null);
  const [cameras, setCameras] = useState<CaptureDevice[]>([]);
  const [microphones, setMicrophones] = useState<CaptureDevice[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const readCameras = useCallback(() => {
    void getCaptureCameras()
      .then(setCameras)
      .catch(() => undefined);
  }, []);
  const readMicrophones = useCallback(() => {
    if (!microphoneAvailable) return;
    void getCaptureMicrophones()
      .then(setMicrophones)
      .catch(() => undefined);
  }, [microphoneAvailable]);

  useEffect(() => {
    readCameras();
    // The camera window reports what it finds where the system has no list.
    const unlisten = listen<CaptureDevice[]>("capture_cameras", (e) => setCameras(e.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [readCameras]);

  useEffect(() => {
    readMicrophones();
  }, [readMicrophones]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [menu]);

  const toggleMenu = (which: SourceMenu) => {
    setMenu((m) => (m === which ? null : which));
    if (which === "camera") readCameras();
    else readMicrophones();
  };

  const pick = (next: CaptureOptions) => {
    setMenu(null);
    onOptions(next);
  };

  const micOn = options.microphone && microphoneAvailable;
  const micName =
    microphones.find((d) => d.id === options.microphoneDevice)?.name ?? microphones.find((d) => d.isDefault)?.name ?? null;

  return (
    <div
      ref={panelRef}
      role="group"
      aria-label="Recording sources"
      className="w-[300px] max-w-[calc(100vw-32px)] rounded-[14px] border border-white/10 bg-[#1c1d21]/85 p-1 shadow-[0_10px_28px_rgba(0,0,0,0.4)] backdrop-blur-xl"
    >
      <SourceRow
        icon={options.screen ? Monitor : MonitorOff}
        label={options.screen ? "Screen" : "Camera only"}
        on={options.screen}
        onToggle={() => pick(toggleScreen(options))}
      />
      <SourceRow
        icon={options.camera ? Video : VideoOff}
        label={sourceLabel(options.camera, options.cameraDevice, cameras, "camera")}
        menuLabel="Camera"
        on={options.camera}
        devices={cameras}
        chosen={options.cameraDevice}
        open={menu === "camera"}
        onOpen={() => toggleMenu("camera")}
        onPick={(id) => pick(pickCamera(options, id))}
        onToggle={() => pick(pickCamera(options, options.camera ? null : (options.cameraDevice ?? "default")))}
      />
      <SourceRow
        icon={micOn ? Mic : MicOff}
        label={sourceLabel(micOn, options.microphoneDevice, microphones, "microphone")}
        menuLabel="Microphone"
        on={options.microphone}
        devices={microphones}
        chosen={options.microphoneDevice}
        open={menu === "microphone"}
        disabled={!microphoneAvailable}
        disabledReason="Recording the microphone needs macOS 15 or later"
        extra={micOn ? <MicMeter deviceName={micName} /> : null}
        onOpen={() => toggleMenu("microphone")}
        onPick={(id) => pick(pickMicrophone(options, id))}
        onToggle={() =>
          pick(pickMicrophone(options, options.microphone ? null : (options.microphoneDevice ?? "default")))
        }
      />
    </div>
  );
}

export interface CaptureBarProps {
  kind: CaptureKind;
  mode: CaptureMode;
  options: CaptureOptions;
  destination: CaptureDestination | null;
  recordingAvailable: boolean;
  microphoneAvailable: boolean;
  showClicksAvailable: boolean;
  hint: string;
  /** Recording the camera alone: no area, window or screen to choose. */
  cameraOnly: boolean;
  onMode: (kind: CaptureKind, mode: CaptureMode) => void;
  /** Open "Choose what to share" on this tab. */
  onChoose: (tab: ShareTab) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onOptionsSaved: (options: CaptureOptions) => void;
  onDestinationSaved: (destination: CaptureDestination) => void;
}

export default function CaptureBar(props: CaptureBarProps) {
  const { kind, mode, options, destination, hint } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // A click anywhere outside the Options menu closes it, as a menu does.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen]);

  const saveOptions = (next: CaptureOptions) => {
    setCaptureOptions(next)
      .then(props.onOptionsSaved)
      .catch(() => undefined);
  };
  const saveDestination = (next: CaptureDestination) => {
    setCaptureDestination(next)
      .then(() => props.onDestinationSaved(next))
      .catch(() => undefined);
  };

  return (
    <div
      className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5 font-[system-ui,-apple-system,'Segoe_UI',sans-serif]"
      // The bar is a control, not part of the selection surface under it.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
    >
      <p className="rounded-full bg-black/70 px-3.5 py-1.5 text-[13px] text-white/90 shadow-lg">{hint}</p>
      {kind === "recording" && (
        <SourcesPanel options={options} microphoneAvailable={props.microphoneAvailable} onOptions={saveOptions} />
      )}
      <div
        role="toolbar"
        aria-label="Capture"
        className="flex items-center gap-1 rounded-[14px] border border-white/10 bg-[#1c1d21]/85 p-1.5 text-white shadow-[0_14px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl"
      >
        <button
          type="button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={props.onCancel}
          className="grid size-7 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" />
        </button>
        {barGroups(props.recordingAvailable).map((group) => (
          <div key={group[0].kind} className="flex items-center gap-0.5">
            <span aria-hidden className="mx-1.5 h-6 w-px bg-white/15" />
            {group.map((entry) => (
              <ModeButton
                key={`${entry.kind}-${entry.mode}`}
                entry={entry}
                active={entry.kind === kind && entry.mode === mode && !(props.cameraOnly && entry.kind === "recording")}
                onPick={() => {
                  // Picking what to record brings the screen back.
                  if (props.cameraOnly && entry.kind === "recording") saveOptions({ ...options, screen: true });
                  props.onMode(entry.kind, entry.mode);
                }}
              />
            ))}
          </div>
        ))}
        <span aria-hidden className="mx-1.5 h-6 w-px bg-white/15" />
        {!props.cameraOnly && (
          <button
            type="button"
            title="Choose a window or screen from a list"
            onClick={() => {
              setMenuOpen(false);
              props.onChoose(shareTabFor(mode));
            }}
            className="flex h-9 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] text-white/85 hover:bg-white/10 hover:text-white"
          >
            <LayoutGrid className="size-3.5" />
            Choose…
          </button>
        )}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-9 items-center gap-1 rounded-[8px] px-2.5 text-[13px] text-white/85 hover:bg-white/10 hover:text-white"
          >
            Options
            <ChevronDown className="size-3.5" />
          </button>
          {menuOpen && (
            <OptionsMenu
              kind={kind}
              options={options}
              destination={destination}
              showClicksAvailable={props.showClicksAvailable}
              onOptions={saveOptions}
              onDestination={saveDestination}
            />
          )}
        </div>
        <button
          type="button"
          onClick={props.onConfirm}
          className="ml-1 h-9 rounded-[9px] bg-[#3167DD] px-4 text-[13px] font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.15)_inset] hover:bg-[#2a5bc6]"
        >
          {confirmLabel(kind)}
        </button>
      </div>
    </div>
  );
}
