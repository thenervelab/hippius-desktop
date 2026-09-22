"use client";

/**
 * Preferences > Encryption > "Server state". Every row is what the
 * homeserver holds right now — account data by direct GET, cross-signing
 * and device signature from /keys/query, backup from /room_keys/version —
 * plus the local facts that have no server counterpart (private keys in
 * this device's crypto store, the backup key we hold). It exists to see,
 * on a broken account, which step of the bootstrap never landed. Ported
 * from the console; the fixed key id comes from the Rust-provided config
 * rather than a frontend constant.
 */

import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Check, RefreshCw, X } from "lucide-react";

import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import { type EncryptionServerState, readEncryptionServerState } from "@/lib/chat/crypto/server-state";
import { cn } from "@/lib/utils";

const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border border-grey-80 px-2.5 py-1 text-xs font-medium text-grey-10 hover:bg-grey-90 disabled:opacity-50 dark:border-black-300 dark:text-grey-light-100 dark:hover:bg-black-300";

export interface DiagnosticsRow {
  label: string;
  /** null = not applicable / unknown, rendered as a dash. */
  ok: boolean | null;
  value?: string;
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

/** Pure: the server state as titled groups of pass/fail rows. */
export function diagnosticsRows(s: EncryptionServerState, hippiusKeyId: string): { title: string; rows: DiagnosticsRow[] }[] {
  const ss = s.secretStorage;
  const cs = s.crossSigning;
  const under = ss.secretsUnderDefaultKey;
  return [
    {
      title: "Secret storage",
      rows: [
        { label: "Default key", ok: ss.defaultKeyId !== null, value: ss.defaultKeyId ?? "none" },
        { label: "Default key name", ok: null, value: ss.defaultKeyName ?? "—" },
        {
          label: "Default key opens with the mnemonic",
          ok: ss.defaultKeyIsDerived,
          value: ss.defaultKeyIsDerived === null ? "unknown (locked)" : yesNo(ss.defaultKeyIsDerived),
        },
        { label: `Hippius key present (${hippiusKeyId})`, ok: ss.hippiusKeyPresent, value: yesNo(ss.hippiusKeyPresent) },
        { label: "Master key stored under default", ok: under.master, value: yesNo(under.master) },
        { label: "Self-signing key stored under default", ok: under.selfSigning, value: yesNo(under.selfSigning) },
        { label: "User-signing key stored under default", ok: under.userSigning, value: yesNo(under.userSigning) },
        { label: "Backup key stored under default", ok: under.backup, value: yesNo(under.backup) },
      ],
    },
    {
      title: "Cross-signing",
      rows: [
        { label: "Master key published", ok: cs.published.master, value: yesNo(cs.published.master) },
        { label: "Self-signing key published", ok: cs.published.selfSigning, value: yesNo(cs.published.selfSigning) },
        { label: "User-signing key published", ok: cs.published.userSigning, value: yesNo(cs.published.userSigning) },
        {
          label: "Private keys on this device (local)",
          ok: cs.privateKeysCached.master && cs.privateKeysCached.selfSigning && cs.privateKeysCached.userSigning,
          value: `master ${yesNo(cs.privateKeysCached.master)} · self ${yesNo(cs.privateKeysCached.selfSigning)} · user ${yesNo(cs.privateKeysCached.userSigning)}`,
        },
      ],
    },
    {
      title: `This device (${s.deviceId})`,
      rows: [
        { label: "Device keys published", ok: s.device.keysPublished, value: yesNo(s.device.keysPublished) },
        { label: "Signed by the self-signing key", ok: s.device.signedBySelfSigningKey, value: yesNo(s.device.signedBySelfSigningKey) },
      ],
    },
    {
      title: "Key backup",
      rows: [
        { label: "Backup version", ok: s.backup.version !== null, value: s.backup.version ?? "none" },
        { label: "Algorithm", ok: null, value: s.backup.algorithm ?? "—" },
        { label: "Room keys in backup", ok: null, value: s.backup.count === null ? "—" : String(s.backup.count) },
        {
          label: "Decryption key held here (local)",
          ok: s.backup.version === null ? null : s.backup.decryptionKeyHeld,
          value: yesNo(s.backup.decryptionKeyHeld),
        },
        {
          label: "Active on this device",
          ok: s.backup.version === null ? null : s.backup.activeVersion === s.backup.version,
          value: s.backup.activeVersion ?? "no",
        },
      ],
    },
  ];
}

export default function EncryptionDiagnostics({ client }: { client: MatrixClient }) {
  const hippiusKeyId = useAtomValue(chatConfigAtom)?.secretStorageKeyId ?? "";
  const [state, setState] = useState<EncryptionServerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    readEncryptionServerState(client, hippiusKeyId)
      .then(setState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not read the server state"))
      .finally(() => setLoading(false));
  }, [client, hippiusKeyId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3 border-t border-grey-80 pt-4 dark:border-black-300">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-grey-10 dark:text-grey-light-100">Server state</h3>
          <p className="mt-0.5 text-xs text-grey-60 dark:text-grey-dark-700">
            Read from the homeserver, not from this device&apos;s cache. Rows marked local are the exceptions.
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading} className={SMALL_BUTTON} aria-label="Refresh server state">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
          Refresh
        </button>
      </div>

      {error ? <p className="text-xs text-error-50 dark:text-error-50">{error}</p> : null}

      {!state && !error ? (
        <ul className="animate-pulse space-y-1.5" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="h-5 rounded bg-grey-90 dark:bg-black-300" />
          ))}
        </ul>
      ) : null}

      {state
        ? diagnosticsRows(state, hippiusKeyId).map((section) => (
            <div key={section.title}>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">{section.title}</p>
              <dl className="divide-y divide-grey-90 rounded-md border border-grey-80 dark:divide-black-300 dark:border-black-300">
                {section.rows.map((row) => (
                  <div key={row.label} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                    <span className="w-4 shrink-0" aria-label={row.ok === null ? "not applicable" : row.ok ? "ok" : "missing"}>
                      {row.ok === null ? (
                        <span className="text-grey-60 dark:text-grey-dark-700">–</span>
                      ) : row.ok ? (
                        <Check className="size-3.5 text-success-50" aria-hidden />
                      ) : (
                        <X className="size-3.5 text-error-50" aria-hidden />
                      )}
                    </span>
                    <dt className="min-w-0 flex-1 text-grey-10 dark:text-grey-light-100">{row.label}</dt>
                    <dd className="max-w-[45%] truncate text-right font-mono text-grey-60 dark:text-grey-dark-700" title={row.value}>
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))
        : null}
    </div>
  );
}
