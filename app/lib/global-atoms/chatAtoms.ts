// Jotai atoms for team chat.
//
// The only state kept here is the feature gate: whether this build/lane
// has chat enabled. The decision is Rust's (`chat_get_config`,
// `src-tauri/src/chat/config.rs` — release channel + env override); the
// frontend keeps no copy of the rule, only the answer.

import { atom } from "jotai";
import type { ChatConfig } from "@/app/lib/tauri/chat";

/**
 * The chat configuration as Rust reports it. `null` means "not fetched
 * yet" — consumers hide the feature until they know, never the reverse.
 * Populated by `useChatConfigLoader` (mounted once in the sidebar).
 */
export const chatConfigAtom = atom<ChatConfig | null>(null);

/**
 * Derived: should the chat surfaces (sidebar entry, `/chat` route) render?
 * `false` while the config is unknown.
 */
export const chatEnabledAtom = atom((get) => get(chatConfigAtom)?.enabled === true);
