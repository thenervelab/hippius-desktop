"use client";

import { useState, useEffect } from "react";

type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

const queries: Record<Exclude<Breakpoint, "xs">, string> = {
  sm: "(min-width: 640px)",
  md: "(min-width: 768px)",
  lg: "(min-width: 1024px)",
  xl: "(min-width: 1280px)",
  "2xl": "(min-width: 1536px)",
};

const useBreakpoint = () => {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("xs");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQueryLists = Object.entries(queries).map(([key, query]) => ({
      key,
      mql: window.matchMedia(query),
    }));

    const getCurrentBreakpoint = (): Breakpoint => {
      const matched = [...mediaQueryLists]
        .reverse()
        .find(({ mql }) => mql.matches);
      return matched ? (matched.key as Breakpoint) : "xs";
    };

    const handleChange = () => {
      setBreakpoint(getCurrentBreakpoint());
    };

    handleChange();

    mediaQueryLists.forEach(({ mql }) => {
      if (mql.addEventListener) {
        mql.addEventListener("change", handleChange);
      } else if (mql.addListener) {
        mql.addListener(handleChange);
      }
    });

    return () => {
      mediaQueryLists.forEach(({ mql }) => {
        if (mql.removeEventListener) {
          mql.removeEventListener("change", handleChange);
        } else if (mql.removeListener) {
          mql.removeListener(handleChange);
        }
      });
    };
  }, []);

  const isMobile = breakpoint === "xs";
  const isTablet = breakpoint === "sm" || breakpoint === "md";
  const isLaptop = breakpoint === "lg";
  const isDesktop = breakpoint === "xl";
  const isLargeDesktop = breakpoint === "2xl";

  return {
    breakpoint,
    isMobile,
    isTablet,
    isLaptop,
    isDesktop,
    isLargeDesktop,
  };
};

export default useBreakpoint;
