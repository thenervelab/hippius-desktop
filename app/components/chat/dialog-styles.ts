/**
 * Class recipes shared by the chat dialogs, lifted from the console's
 * existing FramedDialog forms so the chat dialogs look like every other
 * dialog in the app (and so the palette rules are applied in one place).
 */

export const dialogLabelClassName =
  "text-sm font-medium leading-5 tracking-[-0.28px] text-grey-dark-800 dark:text-grey-dark-200";

export const dialogHintClassName = "mt-1 text-xs text-grey-60 dark:text-grey-dark-700";

export const dialogControlClassName = "mt-1.5 min-h-12 items-center";

export const dialogPrimaryButtonClassName =
  "h-12 w-full gap-2 rounded-[6px] px-4 text-base font-medium leading-5 tracking-[-0.32px]";

export const dialogSecondaryButtonClassName =
  "h-12 w-full rounded-[8px] border border-grey-80 bg-white px-4 text-base font-normal leading-5 tracking-[-0.32px] text-grey-10 hover:rounded-[8px] hover:bg-grey-90 dark:border-black-300 dark:bg-black-300 dark:text-grey-light-100 dark:hover:bg-black-500";

/**
 * Padding only. The width comes from FramedDialog's `maxWidth` prop; a
 * width class here would silently override it.
 */
export const dialogContentClassName = "px-4 pb-4 pt-4 sm:px-4 sm:pb-4 sm:pt-4";

export const dialogTitleClassName =
  "mb-0 truncate text-[22px] leading-8 tracking-normal sm:text-[26px] sm:leading-9";

/**
 * A picker's result list: a fixed height of about six 40 px rows that scrolls,
 * so the dialog does not grow and shrink with every keystroke and the buttons
 * under it stay where the pointer expects them. `shrink` + `min-h-0` let it
 * give up height first on a short viewport.
 */
export const dialogListClassName =
  "h-60 min-h-0 shrink overflow-y-auto rounded-md border border-grey-80 bg-white p-1 dark:border-black-300 dark:bg-black-300";

/** Centered placeholder inside `dialogListClassName` (no results, nothing to suggest). */
export const dialogListEmptyClassName =
  "flex h-full items-center justify-center px-3 text-center text-sm text-grey-60 dark:text-grey-dark-700";

/**
 * Tabbed settings dialogs (`size="xl"`, `fitBody`): the nav + panel row has a
 * fixed height so switching tabs never re-sizes the dialog, and the panel is
 * the single scroll region. Shrinks under the card's max-height on a short
 * viewport rather than overflowing it.
 */
export const dialogTabsClassName = "mt-4 flex h-[440px] min-h-0 shrink flex-col gap-4 font-geist sm:flex-row";

export const dialogTabPanelClassName = "min-h-0 flex-1 overflow-y-auto pr-0.5";

/** Slack-style toggle row used for "Make private" and similar switches. */
export const dialogToggleRowClassName =
  "flex items-start justify-between gap-3 rounded-[10px] border border-grey-80 bg-grey-light-600 px-3 py-2.5 dark:border-black-300 dark:bg-black-primary-bg";
