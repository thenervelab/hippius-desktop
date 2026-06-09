import { useEffect, useRef, useState } from "react";

/**
 * Track whether an element has entered the viewport, for lazily loading
 * expensive content (e.g. cloud thumbnails that cost a download + decrypt).
 *
 * Defaults to `once: true` — once seen, it stays `true` and the observer
 * disconnects, so a thumbnail isn't re-fetched every time it scrolls off and
 * back on. `rootMargin` pre-arms slightly before the element is visible so the
 * content is usually ready by the time the user reaches it.
 *
 * Falls back to `true` where `IntersectionObserver` is unavailable (SSR /
 * static-export prerender) so server-rendered markup never hides content.
 */
export function useInView<T extends Element = HTMLDivElement>(opts?: {
  rootMargin?: string;
  once?: boolean;
}): [React.RefObject<T | null>, boolean] {
  const { rootMargin = "200px", once = true } = opts ?? {};
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, once]);

  return [ref, inView];
}

export default useInView;
