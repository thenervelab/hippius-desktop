"use client";

import { createContext, useContext } from "react";

/**
 * What a host that draws a rule's editor as its own level (the side panel's
 * Link settings) hands the rule cards inside it. With one, the cards do not
 * keep which editor is open themselves: the host does (`rule`), draws the
 * header and the way back, and asks before leaving an editor with changes
 * that are not saved (`dirty`). Without one, the cards push an editor in
 * place under their own back arrow, as in the Share dialog.
 */
export interface RuleStack {
  /** The rule whose editor is asked for, or `null` for the cards. */
  rule: string | null;
  push: (id: string) => void;
  /** The rule whose editor is drawn now (`null` while that rule is not there yet). */
  shown: (id: string | null) => void;
  /** Whether a rule's editor holds changes that are not saved yet. */
  dirty: (id: string, dirty: boolean) => void;
}

export const RuleStackContext = createContext<RuleStack | null>(null);

export function useRuleStack(): RuleStack | null {
  return useContext(RuleStackContext);
}
