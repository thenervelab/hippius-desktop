/**
 * Type declarations for Tauri plugins that may not have proper TypeScript definitions
 * during Next.js build time (they work at runtime in the Tauri environment).
 */

declare module "@tauri-apps/plugin-deep-link" {
  /**
   * Get the deep link URLs that were used to open the app (if any).
   */
  export function getCurrent(): Promise<string[] | null>;

  /**
   * Listen for deep link URL events when the app is already running.
   * @param handler - Callback function that receives the URLs
   * @returns A function to unlisten from the event
   */
  export function onOpenUrl(
    handler: (urls: string[]) => void
  ): Promise<() => void>;
}
