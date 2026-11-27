"use client";

import LinkEngagementSwitches from "@/components/page-sections/drive/LinkEngagementSwitches";
import EmailGateSettings, { useLinkGate, type LinkGateStore } from "@/components/page-sections/shares/insights/EmailGateSettings";
import NdaSettings, { useLinkNda, type LinkNdaStore } from "@/components/page-sections/shares/insights/NdaSettings";
import type { LinkKind } from "@/app/lib/tauri/shareGate";
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
  /** A file link's token; `null` for a folder link, whose rules are `FolderLinkRules`. */
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
  const rules: LinkRule[] =
    shareToken !== null ? accessRules({ shareToken, kind: "file", gateStore, ndaStore, onUpgrade }) : [];

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

/**
 * Who may open the link: Ask for email and Allow list where Rust says the
 * server has email gates for this kind of link, and NDA where Rust offers it
 * (on a password link without a text, a card that says why it can't). The
 * file and folder links' cards, built once so both read the same.
 */
export function accessRules({
  shareToken,
  kind,
  gateStore,
  ndaStore,
  onUpgrade,
}: {
  /** A file link's token, or a folder link's token hash. */
  shareToken: string;
  kind: LinkKind;
  gateStore: LinkGateStore;
  ndaStore: LinkNdaStore;
  onUpgrade: () => void;
}): LinkRule[] {
  const rules: LinkRule[] = [];
  const gate = gateStore.gate;
  if (gate?.offered) {
    rules.push({
      id: "gate",
      label: RULE_LABELS.gate,
      on: gate.on,
      value: GATE_VALUE,
      editor: <EmailGateSettings shareToken={shareToken} kind={kind} onUpgrade={onUpgrade} layout="list" store={gateStore} part="switch" />,
    });
    rules.push({
      id: "allowList",
      label: RULE_LABELS.allowList,
      ...allowListSummary(gate),
      editor: <EmailGateSettings shareToken={shareToken} kind={kind} onUpgrade={onUpgrade} layout="list" store={gateStore} part="lists" />,
    });
  }

  const nda = ndaStore.nda;
  if (nda && !nda.offered && nda.passwordLink) {
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
  } else if (nda?.offered) {
    rules.push({
      id: "nda",
      label: RULE_LABELS.nda,
      ...ndaSummary(nda),
      editor: <NdaSettings shareToken={shareToken} kind={kind} onUpgrade={onUpgrade} layout="list" store={ndaStore} />,
    });
  }
  return rules;
}

/**
 * A folder link's rules as cards, in its Insights panel: Ask for email,
 * Allow list and NDA, each where Rust says the server has it for folder
 * links (`folder_share_gates`, `folder_share_nda`). Named by the listing's
 * token hash, so they work for a link made on another device.
 */
export function FolderLinkRules({
  tokenHash,
  onUpgrade,
  onPushedChange,
  className,
}: {
  tokenHash: string;
  onUpgrade: () => void;
  onPushedChange?: (pushed: boolean) => void;
  className?: string;
}) {
  const gateStore = useLinkGate(tokenHash, "folder");
  const ndaStore = useLinkNda(tokenHash, "folder");
  const rules = accessRules({ shareToken: tokenHash, kind: "folder", gateStore, ndaStore, onUpgrade });
  return <RuleCards rules={rules} onPushedChange={onPushedChange} className={className} />;
}
