"use client";

import type { ShareTtl } from "@/app/lib/tauri/shares";
import { Select } from "@/components/ui/select/Select";
import LinkEngagementSwitches from "@/components/page-sections/drive/LinkEngagementSwitches";
import EmailGateSettings, { useLinkGate } from "@/components/page-sections/shares/insights/EmailGateSettings";
import NdaSettings, { useLinkNda } from "@/components/page-sections/shares/insights/NdaSettings";
import { RuleCards, type LinkRule } from "./RuleCards";
import {
  allowListSummary,
  downloadSummary,
  expirySummary,
  GATE_VALUE,
  ndaSummary,
  passwordSummary,
  RULE_LABELS,
  watermarkSummary,
} from "./ruleSummaries";

/** How long a link lasts: the four the server takes. */
export const TTL_OPTIONS: ReadonlyArray<{ label: string; value: ShareTtl }> = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "Until I revoke it", value: "never" },
];

const NO_SWITCHES = { insights: false, comments: false, reactions: false } as const;

/**
 * A link's rules as cards (`RuleCards`), in the share dialog's finished link
 * and in the Insights panel's Link settings, so both read the same. Each card
 * shows only when its rule exists here: Ask for email and Allow list where
 * Rust says the server has email gates, NDA where Rust offers it, Download
 * where the link has the switch, Expiry and Password where they are known.
 * Watermark only reads today's rule (a PDF while downloads are off), since
 * it is not a setting of its own yet.
 */
export function LinkRules({
  shareToken,
  fileName,
  mimeType = null,
  download = null,
  onDownloadChange,
  downloadRefused = false,
  savingSwitches = false,
  switchesInPlan = null,
  expiresAt,
  expiry,
  passwordOn = null,
  onUpgrade,
  onPushedChange,
  className,
}: {
  /** A file link's token; `null` for a folder link, which has no gate or NDA. */
  shareToken: string | null;
  fileName: string;
  mimeType?: string | null;
  /** Allow download as the link has it; `null` when it has no such switch. */
  download?: boolean | null;
  onDownloadChange?: (on: boolean) => void;
  downloadRefused?: boolean;
  savingSwitches?: boolean;
  switchesInPlan?: boolean | null;
  /** RFC 3339, `null` for never; `undefined` while unknown (no card). */
  expiresAt: string | null | undefined;
  /** How to change it; none makes the card read only. */
  expiry?: { ttl: ShareTtl | null; saving: boolean; onChange: (ttl: ShareTtl) => void } | null;
  /** Whether the link needs a password; `null` when not known here. */
  passwordOn?: boolean | null;
  onUpgrade: () => void;
  onPushedChange?: (pushed: boolean) => void;
  className?: string;
}) {
  const gateStore = useLinkGate(shareToken);
  const ndaStore = useLinkNda(shareToken);
  const rules: LinkRule[] = [];

  const gate = gateStore.gate;
  if (shareToken !== null && gate?.offered) {
    rules.push({
      id: "gate",
      label: RULE_LABELS.gate,
      on: gate.on,
      value: GATE_VALUE,
      editor: <EmailGateSettings shareToken={shareToken} onUpgrade={onUpgrade} layout="list" store={gateStore} part="switch" />,
    });
    rules.push({
      id: "allowList",
      label: RULE_LABELS.allowList,
      ...allowListSummary(gate),
      editor: <EmailGateSettings shareToken={shareToken} onUpgrade={onUpgrade} layout="list" store={gateStore} part="lists" />,
    });
  }

  const nda = ndaStore.nda;
  if (shareToken !== null && nda?.offered) {
    rules.push({
      id: "nda",
      label: RULE_LABELS.nda,
      ...ndaSummary(nda),
      editor: <NdaSettings shareToken={shareToken} onUpgrade={onUpgrade} layout="list" store={ndaStore} />,
    });
  }

  if (shareToken !== null) {
    rules.push({ id: "watermark", label: RULE_LABELS.watermark, ...watermarkSummary(fileName, mimeType, download) });
  }

  if (download !== null && onDownloadChange) {
    rules.push({
      id: "download",
      label: RULE_LABELS.download,
      ...downloadSummary(download),
      editor: (
        <LinkEngagementSwitches
            layout="list"
            offered={NO_SWITCHES}
            value={NO_SWITCHES}
            disabled={savingSwitches}
            switchesInPlan={switchesInPlan}
            onChange={() => undefined}
            onUpgrade={onUpgrade}
            download={download}
            onDownloadChange={onDownloadChange}
            downloadRefused={downloadRefused}
          />
      ),
    });
  }

  if (expiresAt !== undefined) {
    rules.push({
      id: "expiry",
      label: RULE_LABELS.expiry,
      ...expirySummary(expiresAt),
      editor: expiry ? (
        <Select
          ariaLabel="Link expires"
          value={expiry.ttl ?? undefined}
          placeholder="Choose how long it lasts"
          disabled={expiry.saving}
          onValueChange={(value) => expiry.onChange(value as ShareTtl)}
          options={TTL_OPTIONS.map(({ label, value }) => ({ label, value }))}
        />
      ) : undefined,
    });
  }

  if (passwordOn !== null) {
    rules.push({ id: "password", label: RULE_LABELS.password, ...passwordSummary(passwordOn) });
  }

  return <RuleCards rules={rules} onPushedChange={onPushedChange} className={className} />;
}
