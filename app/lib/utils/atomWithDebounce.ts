import { atom, SetStateAction } from "jotai";

type DebounceCfg = {
  delayMilliseconds: number;
  shouldDebounceOnReset: boolean;
  setToLatestAfterDebounce: boolean;
};

const DEFAULT_CFG: DebounceCfg = {
  delayMilliseconds: 500,
  shouldDebounceOnReset: false,
  setToLatestAfterDebounce: false,
};

export function atomWithDebounce<T>(
  initialValue: T,
  cfg: Partial<DebounceCfg> = DEFAULT_CFG
) {
  const { delayMilliseconds, shouldDebounceOnReset, setToLatestAfterDebounce } =
    {
      ...DEFAULT_CFG,
      ...cfg,
    };

  const timeoutAtom = atom<ReturnType<typeof setTimeout> | null>(null);
  const isDebouncingAtom = atom(false);
  const currentValueAtom = atom(initialValue);
  const pendingValueAtom = atom<T>(initialValue);

  const debouncedValueAtom = atom(
    initialValue,
    (get, set, update: SetStateAction<T>) => {
      const prevValue = get(currentValueAtom);
      const nextValue =
        typeof update === "function"
          ? (update as (prev: T) => T)(prevValue)
          : update;

      set(currentValueAtom, nextValue);
      set(pendingValueAtom, nextValue);

      // If reset-to-initial with no debounce
      if (!shouldDebounceOnReset && nextValue === initialValue) {
        clearTimeout(get(timeoutAtom) ?? undefined);
        set(timeoutAtom, null);
        set(isDebouncingAtom, false);
        set(debouncedValueAtom, nextValue);
        return;
      }

      if (setToLatestAfterDebounce) {
        // CLOCK BEHAVIOR — only start timeout if not already set
        if (!get(timeoutAtom)) {
          set(isDebouncingAtom, true);

          const newTimeout = setTimeout(() => {
            const finalValue = get(pendingValueAtom);
            set(debouncedValueAtom, finalValue);
            set(timeoutAtom, null);
            set(isDebouncingAtom, false);
          }, delayMilliseconds);

          set(timeoutAtom, newTimeout);
        }
      } else {
        // CLASSIC DEBOUNCE — clear and reset timeout every time
        clearTimeout(get(timeoutAtom) ?? undefined);
        set(isDebouncingAtom, true);

        const newTimeout = setTimeout(() => {
          set(debouncedValueAtom, nextValue);
          set(timeoutAtom, null);
          set(isDebouncingAtom, false);
        }, delayMilliseconds);

        set(timeoutAtom, newTimeout);
      }
    }
  );

  const clearTimeoutAtom = atom(null, (get, set) => {
    clearTimeout(get(timeoutAtom) ?? undefined);
    set(timeoutAtom, null);
    set(isDebouncingAtom, false);
  });

  return {
    currentValueAtom: atom((get) => get(currentValueAtom)),
    isDebouncingAtom,
    clearTimeoutAtom,
    debouncedValueAtom,
  };
}
