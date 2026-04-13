"use client";

import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";

import SectionHeader from "./SectionHeader";
import { CardButton, Icons, Input, RevealTextLine } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import * as Typography from "@/components/ui/typography";
import { cn } from "@/lib/utils";
import {
  ConsoleAccessStatus,
  PassphraseStrength,
  PassphraseVerdict,
  disableConsoleAccess,
  enableConsoleAccess,
  getConsoleAccessStatus,
  rotateConsolePassphrase,
  validateConsolePassphrase,
} from "@/app/lib/utils/consoleAccess";

/**
 * Settings page for the "Console access" feature — desktop uploads an
 * encrypted mnemonic blob so the Console web app can decrypt files
 * without the desktop running. See
 * `docs/plans/2026-04-13-console-password-blob-*.md`.
 *
 * Every domain decision lives in Rust:
 *   - passphrase strength scoring → `validate_console_passphrase`
 *   - the "ticked backup checkbox" gate → `enable_console_access` rejects
 *     if `confirmedBackup === false`
 *   - enable / rotate / disable state → Rust commands
 *
 * This component only renders state and captures user input.
 */
const ConsoleAccessSettings: React.FC = () => {
  const [status, setStatus] = useState<ConsoleAccessStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getConsoleAccessStatus());
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex flex-col w-full border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <RevealTextLine rotate reveal={inView} parentClassName="w-full" className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.KeySquare}
              title="Console Access"
              subtitle="Enable decrypting your files from the Hippius Console web app, even when this desktop is not running."
            />
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} parentClassName="w-full" className="delay-500 w-full">
            <div className="mt-4">
              {statusError ? (
                <ErrorBlock message={statusError} onRetry={loadStatus} />
              ) : status === null ? (
                <Typography.P size="sm" className="text-grey-50">Loading…</Typography.P>
              ) : status.enabled ? (
                <EnabledSection status={status} onChange={loadStatus} />
              ) : (
                <EnableSection onEnabled={loadStatus} />
              )}
            </div>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default ConsoleAccessSettings;

// ---------------------------------------------------------------------------
// "Not enabled yet" — the onboarding form
// ---------------------------------------------------------------------------

const EnableSection: React.FC<{ onEnabled: () => void }> = ({ onEnabled }) => {
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useLiveStrength(passphrase, setStrength);

  const mismatch = confirmPassphrase.length > 0 && confirmPassphrase !== passphrase;
  const canSubmit =
    !submitting &&
    strength?.acceptableForSubmit === true &&
    !mismatch &&
    passphrase === confirmPassphrase &&
    backupConfirmed;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await enableConsoleAccess(passphrase, backupConfirmed);
      toast.success("Console access enabled.");
      setPassphrase("");
      setConfirmPassphrase("");
      setBackupConfirmed(false);
      onEnabled();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not enable Console access: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, passphrase, backupConfirmed, onEnabled]);

  return (
    <div className="flex flex-col gap-4">
      <Typography.P size="sm" className="text-grey-50">
        Choose a passphrase. It will encrypt your recovery phrase for use on the Console. You will enter this passphrase on each new browser or device — it is <strong>never sent to the server in plaintext</strong>, and cannot be recovered if you forget it.
      </Typography.P>

      <PassphraseField
        label="Console passphrase"
        value={passphrase}
        onChange={setPassphrase}
        autoComplete="new-password"
      />
      <StrengthMeter strength={strength} />

      <PassphraseField
        label="Confirm passphrase"
        value={confirmPassphrase}
        onChange={setConfirmPassphrase}
        autoComplete="new-password"
        errorMessage={mismatch ? "Passphrases do not match." : undefined}
      />

      <BackupConfirmation checked={backupConfirmed} onChange={setBackupConfirmed} />

      <CardButton
        className="self-start"
        onClick={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      >
        Enable Console access
      </CardButton>
    </div>
  );
};

// ---------------------------------------------------------------------------
// "Enabled" — rotate / disable controls
// ---------------------------------------------------------------------------

const EnabledSection: React.FC<{
  status: ConsoleAccessStatus;
  onChange: () => void;
}> = ({ status, onChange }) => {
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  const handleDisableConfirmed = useCallback(async () => {
    setShowDisableDialog(false);
    setDisabling(true);
    try {
      await disableConsoleAccess();
      toast.success("Console access disabled.");
      onChange();
    } catch (err) {
      toast.error(`Could not disable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDisabling(false);
    }
  }, [onChange]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-success-50" />
        <Typography.P size="sm" className="text-grey-10 font-medium">Enabled</Typography.P>
      </div>
      {status.lastUpdatedAt && (
        <Typography.P size="xs" className="text-grey-50">
          Last updated {new Date(status.lastUpdatedAt).toLocaleString()}
        </Typography.P>
      )}

      <div className="flex gap-3 flex-wrap">
        <CardButton onClick={() => setShowRotate(true)} disabled={rotating || disabling}>
          Rotate passphrase
        </CardButton>
        <CardButton
          variant="secondary"
          onClick={() => setShowDisableDialog(true)}
          loading={disabling}
          disabled={rotating}
        >
          Disable
        </CardButton>
      </div>

      {showRotate && (
        <RotateForm
          onDone={() => { setShowRotate(false); onChange(); }}
          onCancel={() => setShowRotate(false)}
          onSubmitting={setRotating}
        />
      )}

      <DisableConfirmDialog
        open={showDisableDialog}
        onClose={() => setShowDisableDialog(false)}
        onConfirm={handleDisableConfirmed}
      />
    </div>
  );
};

const DisableConfirmDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ open, onClose, onConfirm }) => (
  <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogContainer>
      <div className="flex flex-col gap-4 p-6 max-w-md">
        <Dialog.Title asChild>
          <Typography.H4 className="text-grey-10">Disable Console access?</Typography.H4>
        </Dialog.Title>
        <Dialog.Description asChild>
          <Typography.P size="sm" className="text-grey-50">
            Browser sessions that are currently signed in will keep their cached
            mnemonic until they close. To decrypt files from a new browser afterwards,
            you will need to re-enable Console access from here.
          </Typography.P>
        </Dialog.Description>
        <div className="flex gap-2 justify-end mt-2">
          <CardButton variant="secondary" onClick={onClose}>Cancel</CardButton>
          <CardButton onClick={onConfirm}>Disable</CardButton>
        </div>
      </div>
    </DialogContainer>
  </Dialog.Root>
);

const RotateForm: React.FC<{
  onDone: () => void;
  onCancel: () => void;
  onSubmitting: (v: boolean) => void;
}> = ({ onDone, onCancel, onSubmitting }) => {
  const [oldPassphrase, setOldPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmNew, setConfirmNew] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);

  useLiveStrength(newPassphrase, setStrength);

  const mismatch = confirmNew.length > 0 && confirmNew !== newPassphrase;
  const sameAsOld = oldPassphrase.length > 0 && oldPassphrase === newPassphrase;
  const canSubmit =
    oldPassphrase.length > 0 &&
    strength?.acceptableForSubmit === true &&
    !mismatch &&
    newPassphrase === confirmNew &&
    !sameAsOld &&
    backupConfirmed;

  const handleRotate = useCallback(async () => {
    if (!canSubmit) return;
    onSubmitting(true);
    try {
      await rotateConsolePassphrase(oldPassphrase, newPassphrase, backupConfirmed);
      toast.success("Passphrase rotated.");
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Rotation failed: ${msg}`);
    } finally {
      onSubmitting(false);
    }
  }, [canSubmit, oldPassphrase, newPassphrase, backupConfirmed, onSubmitting, onDone]);

  return (
    <div className="flex flex-col gap-3 border border-grey-80 rounded-lg p-4 bg-white">
      <PassphraseField
        label="Current passphrase"
        value={oldPassphrase}
        onChange={setOldPassphrase}
        autoComplete="current-password"
      />
      <PassphraseField
        label="New passphrase"
        value={newPassphrase}
        onChange={setNewPassphrase}
        autoComplete="new-password"
        errorMessage={sameAsOld ? "New passphrase must differ from the current one." : undefined}
      />
      <StrengthMeter strength={strength} />
      <PassphraseField
        label="Confirm new passphrase"
        value={confirmNew}
        onChange={setConfirmNew}
        autoComplete="new-password"
        errorMessage={mismatch ? "New passphrases do not match." : undefined}
      />
      <BackupConfirmation checked={backupConfirmed} onChange={setBackupConfirmed} />
      <div className="flex gap-2">
        <CardButton onClick={handleRotate} disabled={!canSubmit}>Rotate</CardButton>
        <CardButton variant="secondary" onClick={onCancel}>Cancel</CardButton>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shared presentational pieces
// ---------------------------------------------------------------------------

const PassphraseField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  errorMessage?: string;
}> = ({ label, value, onChange, autoComplete, errorMessage }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs font-medium text-grey-30">{label}</span>
    <Input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete ?? "off"}
      autoCapitalize="off"
      spellCheck={false}
    />
    {errorMessage && <span className="text-xs text-error-60">{errorMessage}</span>}
  </label>
);

// Per-verdict CSS classes only — no labels, no thresholds. The text
// label comes from `strength.label` (Rust-owned); the progress value
// comes from `strength.progressPercent` (Rust-owned). This component
// is pure presentation — the only thing it decides is which Tailwind
// colour to use for each verdict.
const VERDICT_STYLES: Record<PassphraseVerdict, { bar: string; text: string }> = {
  too_short: { bar: "bg-grey-70",    text: "text-grey-40" },
  weak:      { bar: "bg-error-60",   text: "text-error-60" },
  ok:        { bar: "bg-warning-50", text: "text-warning-50" },
  strong:    { bar: "bg-success-50", text: "text-success-60" },
};

const StrengthMeter: React.FC<{ strength: PassphraseStrength | null }> = ({ strength }) => {
  if (!strength) return null;
  const style = VERDICT_STYLES[strength.verdict];
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full bg-grey-90 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-[width]", style.bar)}
          style={{ width: `${strength.progressPercent}%` }}
        />
      </div>
      <div className="flex justify-between text-xs">
        <span className={style.text}>{strength.label}</span>
        <span className="text-grey-50">{strength.bits.toFixed(0)} bits</span>
      </div>
      {strength.hints.length > 0 && (
        <ul className="mt-1 list-disc list-inside text-xs text-grey-50 space-y-0.5">
          {strength.hints.map((h, i) => (
            <li key={`${i}-${h.slice(0, 20)}`}>{h}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const BackupConfirmation: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ checked, onChange }) => (
  <label className="flex items-start gap-2 cursor-pointer select-none">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-1 size-4"
    />
    <span className="text-xs text-grey-30 leading-relaxed">
      I have saved my recovery phrase offline. I understand that without it <strong>and</strong> without my passphrase, my files cannot be recovered.
    </span>
  </label>
);

const ErrorBlock: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="flex flex-col gap-2">
    <Typography.P size="sm" className="text-error-60">
      Couldn&apos;t load Console access status.
    </Typography.P>
    <Typography.P size="xs" className="text-grey-50">{message}</Typography.P>
    <CardButton variant="secondary" onClick={onRetry} className="self-start">Try again</CardButton>
  </div>
);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Debounced live passphrase strength fetcher. Every score call goes
 * through the Rust IPC so the scoring rules never diverge between
 * backend and frontend.
 */
function useLiveStrength(passphrase: string, setStrength: (s: PassphraseStrength | null) => void) {
  useEffect(() => {
    if (passphrase.length === 0) {
      setStrength(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      validateConsolePassphrase(passphrase)
        .then((s) => { if (!cancelled) setStrength(s); })
        .catch(() => { if (!cancelled) setStrength(null); });
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [passphrase, setStrength]);
}
