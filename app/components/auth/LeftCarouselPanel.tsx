"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { InView } from "react-intersection-observer";
import { SWIPE_CONTENT } from "./SwipeContent";
import { Swiper, SwiperSlide } from "swiper/react";
import { Pagination, EffectFade } from "swiper/modules";
import type { Swiper as SwiperClass } from "swiper";
import AuthTitleBar from "./AuthTitleBar";
import { computeCropLockScale } from "./carouselCrop";
import { useAppTheme } from "@/lib/theme-context";
import "swiper/css";
import "swiper/css/pagination";
import "swiper/css/effect-fade";

const LeftCarouselPanel = () => {
  // Theme: read the app's resolved theme (the user's System/Light/Dark
  // preference applied by AppThemeProvider) rather than prefers-color-scheme
  // directly, so a forced Light/Dark picks the matching clip. `isLoaded`
  // gates the <img> so the theme-keyed GIF first renders only after the
  // preference is resolved on the client — the static export prerenders
  // with the light src, so without this the first client paint would
  // hydrate-mismatch (and briefly flash) the wrong theme's clip.
  const { isLoaded: themeLoaded, resolvedTheme } = useAppTheme();
  const prefersDark = resolvedTheme === "dark";
  const mounted = themeLoaded;
  // The active slide is React state because we mount the <img> for ONLY that
  // slide (plus the outgoing one mid-crossfade). A GIF starts animating from
  // its first frame the moment it mounts, so mounting only the active clip is
  // what makes each slide restart its animation from the top when you land on
  // it — and keeps idle slides from holding decoded GIF frames in memory.
  const [activeIndex, setActiveIndex] = useState(0);
  // The slide we're transitioning AWAY from; non-null only while the crossfade
  // is in flight. Dropped on transition end so we settle back to one clip.
  const [prevIndex, setPrevIndex] = useState<number | null>(null);
  // True once the active slide's GIF has decoded its first frame (img onLoad).
  // The auto-advance timer only starts then, so its countdown measures from
  // when the clip is actually on screen rather than from the slide change —
  // the closest a timer can get to "the GIF started playing".
  const [activeReady, setActiveReady] = useState(false);

  const swiperRef = useRef<SwiperClass | null>(null);
  const videoFrameRef = useRef<HTMLDivElement | null>(null);
  const baseFrameRef = useRef<{ width: number; height: number } | null>(null);
  // Once the user interacts (clicks a pagination dot or swipes), we stop
  // auto-advancing and just loop whatever slide they landed on.
  const manualLoopRef = useRef(false);
  const [manualLoop, setManualLoop] = useState(false);
  // Set right before our own programmatic slideTo() so onSlideChange can tell
  // an auto-advance apart from a user-initiated change.
  const autoAdvancingRef = useRef(false);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = videoFrameRef.current;
    if (!node) return;

    const updateSize = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setFrameSize({ width, height });
      if (!baseFrameRef.current) {
        baseFrameRef.current = { width, height };
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeIndex]);

  // Auto-advance timer — the GIF stand-in for the old <video> `ended` event.
  // A GIF reports neither its end nor its position, so we advance after the
  // slide's hand-measured `durationMs` (see SwipeContent). It starts only once
  // the clip is on screen (`activeReady`) and is suppressed after a manual
  // interaction (`manualLoop`), letting the infinitely-looping GIF play in
  // place. Re-running on every activeIndex change clears the previous timer, so
  // a user landing on a slide can never inherit a stale countdown.
  useEffect(() => {
    if (!activeReady || manualLoop) return;
    const swiper = swiperRef.current;
    if (!swiper) return;
    const durationMs = SWIPE_CONTENT[activeIndex]?.durationMs ?? 5000;
    const timer = window.setTimeout(() => {
      autoAdvancingRef.current = true;
      swiper.slideTo((activeIndex + 1) % SWIPE_CONTENT.length);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [activeIndex, activeReady, manualLoop]);

  const handleSlideChange = useCallback((swiper: SwiperClass) => {
    // A change we didn't trigger ourselves is a user interaction (dot click or
    // swipe): from here on, loop in place rather than auto-advance.
    if (autoAdvancingRef.current) {
      autoAdvancingRef.current = false;
    } else {
      manualLoopRef.current = true;
      setManualLoop(true);
    }
    // The incoming slide's GIF must load before its timer may start; gate it
    // shut until this slide's <img> fires onLoad.
    setActiveReady(false);
    setActiveIndex(swiper.activeIndex);
  }, []);

  // Keep the outgoing slide's <img> mounted for the duration of the crossfade
  // so it fades out on its current frame rather than an empty panel.
  const handleTransitionStart = useCallback((swiper: SwiperClass) => {
    if (swiper.previousIndex !== swiper.activeIndex) {
      setPrevIndex(swiper.previousIndex);
    }
  }, []);

  // Crossfade finished: drop the outgoing clip so we hold a single GIF.
  const handleTransitionEnd = useCallback(() => {
    setPrevIndex(null);
  }, []);

  const cropLockScale = computeCropLockScale(baseFrameRef.current, frameSize);

  return (
    // Both backgrounds are set to each theme's GIF's own flat background color
    // (#fffdff light, #161416 dark) rather than the grey-light-100 / black-500
    // tokens (#ffffff / #161616). The clips are wider than the panel and, on
    // slides with negative cropX, zoomed out — so the panel background shows
    // through as a letterbox right next to the GIF's background. Matching them
    // exactly makes that seam vanish. Re-sample (convert <gif>[0] -format
    // '%[pixel:p{2,2}]' info:) and update here if the GIF backgrounds change.
    <div className="relative w-full h-full min-h-full max-h-full rounded-[11px] bg-[#fffdff] dark:bg-[#161416] overflow-hidden flex flex-col">
      <AuthTitleBar />
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref} className="flex-1 min-h-0 w-full">
            <Swiper
              modules={[Pagination, EffectFade]}
              effect="fade"
              fadeEffect={{ crossFade: true }}
              // A longer fade reads as a deliberate crossfade and gives the
              // incoming clip time to decode its first frame before it is fully
              // opaque, so the new slide doesn't flash blank mid-transition.
              speed={600}
              onSwiper={(swiper) => {
                swiperRef.current = swiper;
              }}
              onSlideChange={handleSlideChange}
              onSlideChangeTransitionStart={handleTransitionStart}
              onSlideChangeTransitionEnd={handleTransitionEnd}
              pagination={{
                clickable: true,
                bulletClass: "swiper-pagination-bullet auth-carousel-bullet",
                bulletActiveClass:
                  "swiper-pagination-bullet-active auth-carousel-bullet-active",
              }}
              className="auth-carousel-swiper w-full h-full"
            >
              {SWIPE_CONTENT.map((item, index) => (
                <SwiperSlide key={item.title}>
                  <div
                    className={`relative w-full h-full flex flex-col pt-[clamp(1rem,7vh,5rem)] pb-[clamp(1rem,5vh,3rem)] transition-opacity duration-500 ${
                      inView ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    <div className="w-full px-[min(2.5rem,40px)] 2xl:px-[66px] flex flex-col gap-[4px]">
                      <p className="text-[min(1.75rem,28px)] leading-[min(2rem,32px)] tracking-[-0.03em] font-medium text-grey-10 dark:text-grey-primary-bg max-w-[min(33rem,527px)]">
                        {item.title}
                      </p>
                      <p className="text-[min(1rem,16px)] leading-[min(1.375rem,22px)] tracking-[-0.02em] text-grey-50 max-w-[min(33rem,527px)]">
                        {item.description}
                      </p>
                    </div>

                    <div
                      ref={index === activeIndex ? videoFrameRef : undefined}
                      className="flex-1 min-h-0 w-full relative overflow-hidden"
                    >
                      {/*
                       * Only the active slide — plus the outgoing one while a
                       * crossfade is in flight — mounts an <img> (see
                       * activeIndex/prevIndex above). Keying the element by its
                       * own slide index (not activeIndex) lets React preserve
                       * the outgoing element so it fades out on its current
                       * frame instead of being remounted blank. The clip is
                       * center-framed and wider than the panel, so we center it
                       * and size to the container height (h-full w-auto
                       * max-w-none). `cropX` scales from the centre: negative
                       * zooms out to contain more of the sides, positive crops
                       * more (see SwipeContent). We also apply a resize lock so
                       * panel size changes do not reveal more/less of the clip.
                       * Auto-advance is driven by the durationMs timer above
                       * (GIFs report no `ended` event); after a manual
                       * interaction that timer is suppressed and the GIF, which
                       * is exported to loop, keeps playing in place.
                       */}
                      {mounted &&
                        (index === activeIndex || index === prevIndex) && (
                          <img
                            key={`${index}-${prefersDark}`}
                            src={prefersDark ? item.gifDark : item.gif}
                            alt=""
                            aria-hidden
                            draggable={false}
                            onLoad={
                              index === activeIndex
                                ? () => setActiveReady(true)
                                : undefined
                            }
                            style={{
                              transform: `translate(-50%, -50%) scale(${
                                (1 + item.cropX / 100) * cropLockScale
                              })`,
                            }}
                            className="absolute left-1/2 top-1/2 h-full w-auto max-w-none block select-none pointer-events-none"
                          />
                        )}
                    </div>
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
          </div>
        )}
      </InView>

      <style jsx global>{`
        .auth-carousel-swiper .swiper-pagination {
          bottom: 22px !important;
          display: flex;
          justify-content: center;
          gap: 6px;
        }
        .auth-carousel-bullet {
          width: 9px !important;
          height: 9px !important;
          background: #000 !important;
          opacity: 0.1 !important;
          margin: 0 !important;
          border-radius: 28px !important;
          transition: opacity 0.2s ease;
        }
        .auth-carousel-bullet-active {
          opacity: 1 !important;
        }
        /*
         * Dark mode keys off the .dark class AppThemeProvider toggles on
         * <html> (Tailwind darkMode: "selector"), so the bullets follow the
         * user's System/Light/Dark preference, not just the OS.
         *
         * The active rule must be re-declared AFTER the inactive override so it
         * wins on source order: both selectors are equal specificity/!important,
         * so without this the inactive opacity would dim the active dot too.
         */
        .dark .auth-carousel-bullet {
          background: #ebebeb !important;
          opacity: 0.2 !important;
        }
        .dark .auth-carousel-bullet-active {
          opacity: 1 !important;
        }
      `}</style>
    </div>
  );
};

export default LeftCarouselPanel;
