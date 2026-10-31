"use client";

/**
 * "Also turn off its links" in a capture's delete confirmation: ticked by
 * default, and only offered when the capture has links. Ticked, the links
 * (and their chat previews) are turned off once the delete succeeds
 * (`delete_files`). Unticked, the dialog says the links keep working.
 */
export default function TurnOffLinksOption({
  checked,
  onChange,
  linkCount,
  multiple,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  linkCount: number;
  /** More than one file is being deleted. */
  multiple: boolean;
  disabled?: boolean;
}) {
  if (linkCount === 0) return null;
  return (
    <div className="mb-6" data-testid="turn-off-links">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-grey-10 dark:text-grey-dark-800">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 shrink-0 accent-primary-50"
        />
        {multiple ? "Also turn off their links" : "Also turn off its links"}
      </label>
      <p className="mt-1 pl-6 text-xs text-grey-50 dark:text-grey-dark-600">
        {checked
          ? linkCount === 1
            ? "Anyone with the link won't be able to open it any more."
            : `Anyone with one of the ${linkCount} links won't be able to open it any more.`
          : "The links keep working. You can turn them off in Shared Links."}
      </p>
    </div>
  );
}
