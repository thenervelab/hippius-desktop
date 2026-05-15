"use client";

type ScrollTarget = Window | HTMLElement;

const getScrollTarget = (start: HTMLElement | null): ScrollTarget => {
  let current = start;

  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight;
    const canScrollX =
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      current.scrollWidth > current.clientWidth;

    if (canScrollX || canScrollY) {
      return current;
    }

    current = current.parentElement;
  }

  return window;
};

export const preserveClosestScrollPosition = (
  start: HTMLElement | null,
  mutate: () => void,
) => {
  const target = getScrollTarget(start);
  const isWindowTarget = target === window;
  const x = isWindowTarget ? window.scrollX : target.scrollLeft;
  const y = isWindowTarget ? window.scrollY : target.scrollTop;

  mutate();

  window.requestAnimationFrame(() => {
    if (isWindowTarget) {
      if (window.scrollX !== x || window.scrollY !== y) {
        window.scrollTo(x, y);
      }
      return;
    }

    if (target.scrollLeft !== x || target.scrollTop !== y) {
      target.scrollLeft = x;
      target.scrollTop = y;
    }
  });
};
