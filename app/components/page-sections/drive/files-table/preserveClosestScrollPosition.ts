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
  const elementTarget = target instanceof HTMLElement ? target : null;
  const x = elementTarget ? elementTarget.scrollLeft : window.scrollX;
  const y = elementTarget ? elementTarget.scrollTop : window.scrollY;

  mutate();

  window.requestAnimationFrame(() => {
    if (!elementTarget) {
      if (window.scrollX !== x || window.scrollY !== y) {
        window.scrollTo(x, y);
      }
      return;
    }

    if (elementTarget.scrollLeft !== x || elementTarget.scrollTop !== y) {
      elementTarget.scrollLeft = x;
      elementTarget.scrollTop = y;
    }
  });
};
