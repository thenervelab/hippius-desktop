"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { InView } from "react-intersection-observer";
import { SWIPE_CONTENT } from "./SwipeContent";
import { Swiper, SwiperSlide } from "swiper/react";
import { Pagination, EffectFade } from "swiper/modules";
import type { Swiper as SwiperClass } from "swiper";
import AuthTitleBar from "./AuthTitleBar";
import "swiper/css";
import "swiper/css/pagination";
import "swiper/css/effect-fade";

const LeftCarouselPanel = () => {
  // Theme: the app uses Tailwind's media dark-mode strategy (no .dark class),
  // so we mirror it by reading prefers-color-scheme directly to pick the clip.
  const [prefersDark, setPrefersDark] = useState(false);
  // The active slide is React state because we mount the <video> for ONLY that
  // slide. Linux's WebKitGTK webview has a small simultaneous-video-decoder
  // pool; mounting all four clips at once exhausts it and later slides freeze
  // on their first frame. Keeping exactly one <video> alive sidesteps that.
  const [activeIndex, setActiveIndex] = useState(0);

  const swiperRef = useRef<SwiperClass | null>(null);
  // Once the user interacts (clicks a pagination dot or swipes), we stop
  // auto-advancing and just loop whatever slide they landed on.
  const manualLoopRef = useRef(false);
  // Set right before our own programmatic slideTo() so onSlideChange can tell
  // an auto-advance apart from a user-initiated change.
  const autoAdvancingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const handleSlideChange = useCallback((swiper: SwiperClass) => {
    // A change we didn't trigger ourselves is a user interaction (dot click or
    // swipe): from here on, loop in place rather than auto-advance.
    if (autoAdvancingRef.current) {
      autoAdvancingRef.current = false;
    } else {
      manualLoopRef.current = true;
    }
    setActiveIndex(swiper.activeIndex);
  }, []);

  const handleEnded = useCallback((video: HTMLVideoElement, index: number) => {
    // After interaction we loop the current clip in place instead of moving on.
    if (manualLoopRef.current) {
      video.currentTime = 0;
      void video.play().catch(() => {});
      return;
    }
    const swiper = swiperRef.current;
    if (!swiper) return;
    autoAdvancingRef.current = true;
    swiper.slideTo((index + 1) % SWIPE_CONTENT.length);
  }, []);

  return (
    <div className="relative w-full h-full min-h-full max-h-full rounded-[11px] bg-grey-light-100 dark:bg-black-500 overflow-hidden flex flex-col">
      <AuthTitleBar />
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref} className="flex-1 min-h-0 w-full">
            <Swiper
              modules={[Pagination, EffectFade]}
              effect="fade"
              fadeEffect={{ crossFade: true }}
              onSwiper={(swiper) => {
                swiperRef.current = swiper;
              }}
              onSlideChange={handleSlideChange}
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

                    <div className="flex-1 min-h-0 w-full relative overflow-hidden">
                      {/*
                       * Only the active slide mounts a <video> (decoder-pool
                       * limit, see activeIndex above). The clip is center-framed
                       * and wider than the panel, so we center it and size to the
                       * container height (h-full w-auto max-w-none); the surplus
                       * width spills past the edges and is clipped by the parent's
                       * overflow-hidden, cropping the empty side margins. `cropX`
                       * scales from the centre: negative zooms out to contain
                       * more of the sides, positive crops more (see SwipeContent).
                       * No `loop` attribute — it would suppress the `ended` event we
                       * use to advance. autoPlay + the onCanPlay nudge start it
                       * reliably even when the clip needs a moment to buffer.
                       */}
                      {index === activeIndex && (
                        <video
                          key={`${activeIndex}-${prefersDark}`}
                          src={prefersDark ? item.videoDark : item.video}
                          autoPlay
                          muted
                          playsInline
                          preload="auto"
                          onCanPlay={(e) => {
                            if (e.currentTarget.paused)
                              void e.currentTarget.play().catch(() => {});
                          }}
                          onEnded={(e) => handleEnded(e.currentTarget, index)}
                          style={{
                            transform: `translate(-50%, -50%) scale(${
                              1 + item.cropX / 100
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
         * Dark mode uses prefers-color-scheme, NOT a .dark class: this app's
         * Tailwind runs the default media strategy (darkMode is commented out
         * in tailwind.config.ts) and nothing adds a .dark class at runtime. A
         * .dark selector here would never match, leaving the active bullet at
         * the light-mode solid black — invisible on the dark panel.
         *
         * The active rule must be re-declared AFTER the inactive override so it
         * wins on source order: both selectors are equal specificity/!important,
         * so without this the inactive opacity would dim the active dot too.
         */
        @media (prefers-color-scheme: dark) {
          .auth-carousel-bullet {
            background: #ebebeb !important;
            opacity: 0.2 !important;
          }
          .auth-carousel-bullet-active {
            opacity: 1 !important;
          }
        }
      `}</style>
    </div>
  );
};

export default LeftCarouselPanel;
