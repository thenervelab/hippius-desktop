"use client";

import LinkEngagementSwitches from "@/components/page-sections/drive/LinkEngagementSwitches";
import EmailGateSettings, { useLinkGate } from "@/components/page-sections/shares/insights/EmailGateSettings";
import NdaSettings, { useLinkNda } from "@/components/page-sections/shares/insights/NdaSettings";
import { MUTED } from "@/components/page-sections/shares/insights/panelStyles";
import { RuleCards, type LinkRule } from "./RuleCards";
import { ExpiryEditor, TTL_OPTIONS, type ExpiryEdit } from "./ExpiryEditor";
import {
  allowListSummary,
  downloadSummary,
  expirySummary,
  GATE_VALUE,
  isWatermarkable,
  NDA_PASSWORD_REASON,
  NDA_PASSWORD_VALUE,
  ndaSummary,
  passwordSummary,
  RULE_LABELS,
  watermarkSummary,
} from "./ruleSummaries";

export { TTL_OPTIONS };

const NO_SWITCHES = { insights: false, comments: false, reactions: false } as const;

/**
 * A link's rules as cards (`RuleCards`), in the share dialog's finished link
 * and in the Insights panel's Link settings, so both read the same. Each card
 * shows only when its rule exists here: Ask for email and Allow list where
 * Rust says the server has email gates, NDA where Rust offers it, Download
 * where the link has the switch, Expiry and Password where they are known.
 * Watermark is a switch of its own where the server has one
 * (`share_watermark_switch`, Rust then sends `watermark`); elsewhere it only
 * reads the older rule, a PDF while downloads are off. Expiry offers a
 * chosen date beside the presets where the server takes one.
 */
export function LinkRules({
  shareToken,
  fileName,
  mimeType = null,
  download = null,
  onDownloadChange,
  downloadRefused = false,
  watermark = null,
  onWatermarkChange,
  watermarkRefused = false,
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
  /** The watermark as the link has it; `null` where it is not a setting of its own. */
  watermark?: boolean | null;
  onWatermarkChange?: (on: boolean) => void;
  watermarkRefused?: boolean;
  savingSwitches?: boolean;
  switchesInPlan?: boolean | null;
  /** RFC 3339, `null` for never; `undefined` while unknown (no card). */
  expiresAt: string | null | undefined;
  /** How to change it; none makes the card read only. */
  expiry?: ExpiryEdit | null;
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
  if (shareToken !== null && nda && !nda.offered && nda.passwordLink) {
    rules.push({
      id: "nda",
      label: RULE_LABELS.nda,
      on: false,
      value: NDA_PASSWORD_VALUE,
      editor: (
        <p className={`text-xs ${MUTED}`} data-testid="nda-password-reason">
          {NDA_PASSWORD_REASON}
        </p>
      ),
    });
  } else if (shareToken !== null && nda?.offered) {
    rules.push({
      id: "nda",
      label: RULE_LABELS.nda,
      ...ndaSummary(nda),
      editor: <NdaSettings shareToken={shareToken} onUpgrade={onUpgrade} layout="list" store={ndaStore} />,
    });
  }

  if (shareToken !== null) {
    const summary = watermarkSummary(fileName, mimeType, download, watermark);
    // A switch only for a PDF, the one file the share page draws it on.
    const editable = watermark !== null && onWatermarkChange !== undefined && isWatermarkable(fileName, mimeType);
    rules.push({
      id: "watermark",
      label: RULE_LABELS.watermark,
      ...summary,
      editor: editable ? (
        <LinkEngagementSwitches
          layout="list"
          offered={NO_SWITCHES}
          value={NO_SWITCHES}
          disabled={savingSwitches}
          switchesInPlan={switchesInPlan}
          onChange={() => undefined}
          onUpgrade={onUpgrade}
          watermark={watermark}
          onWatermarkChange={onWatermarkChange}
          watermarkRefused={watermarkRefused}
        />
      ) : undefined,
    });
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
            ownWatermark={watermark !== null}
          />
      ),
    });
  }

  if (expiresAt !== undefined) {
    rules.push({
      id: "expiry",
      label: RULE_LABELS.expiry,
      ...expirySummary(expiresAt),
      editor: expiry ? <ExpiryEditor expiry={expiry} expiresAt={expiresAt} /> : undefined,
    });
  }

  if (passwordOn !== null) {
    rules.push({ id: "password", label: RULE_LABELS.password, ...passwordSummary(passwordOn) });
  }

  return <RuleCards rules={rules} onPushedChange={onPushedChange} className={className} />;
}
