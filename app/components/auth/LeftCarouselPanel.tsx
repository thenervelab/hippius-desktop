"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { InView } from "react-intersection-observer";
import { SWIPE_CONTENT } from "./SwipeContent";
import { Swiper, SwiperSlide } from "swiper/react";
import { Pagination, EffectFade } from "swiper/modules";
import type { Swiper as SwiperClass } from "swiper";
import AuthTitleBar from "./AuthTitleBar";
import { computeCropLockScale } from "./carouselCrop";
import "swiper/css";
import "swiper/css/pagination";
import "swiper/css/effect-fade";

const LeftCarouselPanel = () => {
  // Theme: the app uses Tailwind's media dark-mode strategy (no .dark class),
  // so we mirror it by reading prefers-color-scheme directly to pick the clip.
  const [prefersDark, setPrefersDark] = useState(false);
  // Gate the <video> behind a client-mount flag so it first mounts only AFTER
  // `prefersDark` is resolved below. Otherwise the SSR/first paint mounts the
  // light clip, then the theme effect flips `prefersDark`, the keyed <video>
  // remounts to the dark src mid-autoplay, and WKWebView drops that second
  // play() — leaving slide 0 paused with the overlay play button (slides 2-4
  // are unaffected because they first mount after the theme has settled).
  const [mounted, setMounted] = useState(false);
  // The active slide is React state because we mount the <video> for ONLY that
  // slide. Linux's WebKitGTK webview has a small simultaneous-video-decoder
  // pool; mounting all four clips at once exhausts it and later slides freeze
  // on their first frame. We therefore keep at most TWO clips alive: the active
  // one, plus the outgoing one for the brief duration of the crossfade so the
  // fade-out shows its real last frame instead of an empty panel.
  const [activeIndex, setActiveIndex] = useState(0);
  // The slide we're transitioning AWAY from; non-null only while the crossfade
  // is in flight. Dropped on transition end so we settle back to one decoder.
  const [prevIndex, setPrevIndex] = useState<number | null>(null);

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
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(mq.matches);
    // Batched with setPrefersDark, so the video's first mount already has the
    // correct theme src — no remount, so autoplay survives on slide 0.
    setMounted(true);
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Tauri's WKWebView requires a user gesture before it will start media
  // playback (its default), so the muted programmatic play() in `primeVideo` is
  // refused on a cold load and slide 0 freezes on its first frame until the
  // user interacts — after which everything (including auto-advance) works.
  // Kickstart the active slide's <video> on the very first interaction ANYWHERE
  // in the window (a mouse move/click/scroll/key, which happens within moments
  // of the login screen appearing). One-shot: each listener removes itself.
  useEffect(() => {
    const playActive = () => {
      const video = videoFrameRef.current?.querySelector("video");
      if (video) void video.play().catch(() => {});
      cleanup();
    };
    const events = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
      "touchstart",
    ] as const;
    const cleanup = () =>
      events.forEach((e) => window.removeEventListener(e, playActive));
    events.forEach((e) =>
      window.addEventListener(e, playActive, { once: true, passive: true }),
    );
    return cleanup;
  }, []);

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

  const handleSlideChange = useCallback((swiper: SwiperClass) => {
    // A change we didn't trigger ourselves is a user interaction (dot click or
    // swipe): from here on, loop in place rather than auto-advance.
    if (autoAdvancingRef.current) {
      autoAdvancingRef.current = false;
    } else {
      manualLoopRef.current = true;
      setManualLoop(true);
    }
    setActiveIndex(swiper.activeIndex);
  }, []);

  // Keep the outgoing slide's <video> mounted for the duration of the crossfade
  // so it fades out on its last decoded frame rather than an empty panel.
  const handleTransitionStart = useCallback((swiper: SwiperClass) => {
    if (swiper.previousIndex !== swiper.activeIndex) {
      setPrevIndex(swiper.previousIndex);
    }
  }, []);

  // Crossfade finished: drop the outgoing clip so we hold a single decoder.
  const handleTransitionEnd = useCallback(() => {
    setPrevIndex(null);
  }, []);

  const handleEnded = useCallback((video: HTMLVideoElement, index: number) => {
    // After interaction we loop the current clip in place instead of moving on.
    if (manualLoopRef.current) {
      return;
    }
    const swiper = swiperRef.current;
    if (!swiper) return;
    autoAdvancingRef.current = true;
    swiper.slideTo((index + 1) % SWIPE_CONTENT.length);
  }, []);

  // Autoplay on the very first page load is the tricky case (after any
  // navigation the document has a user gesture, so play() always works).
  //
  // We deliberately do NOT use the `autoplay` attribute. WKWebView evaluates it
  // at parse time, and because React emits `muted` as a *property* (not the HTML
  // attribute), it sees an un-muted clip, blocks the autoplay, and paints its
  // native "tap to play" overlay. Once blocked, a later programmatic play() is
  // refused (no user gesture) — so slide 0 stays paused on first load while
  // slides 2-4 (mounted after a gesture) are fine.
  //
  // Instead we force the element muted (property AND attribute, so the gate can
  // never see it un-muted) and start it ourselves: a *muted* programmatic
  // play() is allowed with no user gesture. The play() is retried on the first
  // readiness event in case the ref attaches before the media can play.
  const primeVideo = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    video.defaultMuted = true;
    video.muted = true;
    video.setAttribute("muted", "");
    const play = () => void video.play().catch(() => {});
    play();
    // One-shot retries: harmless no-ops if it's already playing, and the
    // listeners die with the element on the next remount/unmount.
    video.addEventListener("loadeddata", play, { once: true });
    video.addEventListener("canplay", play, { once: true });
  }, []);

  const cropLockScale = computeCropLockScale(baseFrameRef.current, frameSize);

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
                       * crossfade is in flight — mounts a <video> (decoder-pool
                       * limit, see activeIndex/prevIndex above). Keying the
                       * element by its own slide index (not activeIndex) lets
                       * React preserve the outgoing element so it fades out on
                       * its real last frame instead of being remounted blank.
                       * The clip is center-framed and wider than the panel, so we
                       * center it and size to the container height (h-full w-auto
                       * max-w-none). `cropX` scales from the centre: negative
                       * zooms out to contain more of the sides, positive crops
                       * more (see SwipeContent). We also apply a resize lock so
                       * panel size changes do not reveal more/less of the clip.
                       * We only enable `loop` after manual interaction so the
                       * `ended` event can still drive auto-advance otherwise.
                       * `primeVideo` (the ref) forces the element muted and
                       * starts it with a programmatic play(), retried on the
                       * first readiness event — see its comment for why we avoid
                       * the `autoplay` attribute.
                       */}
                      {mounted &&
                        (index === activeIndex || index === prevIndex) && (
                        <video
                          key={`${index}-${prefersDark}`}
                          ref={primeVideo}
                          src={prefersDark ? item.videoDark : item.video}
                          // No `autoPlay` on purpose — primeVideo starts it via a
                          // muted programmatic play() so WKWebView can't block the
                          // first-load autoplay and paint the overlay button.
                          muted
                          playsInline
                          loop={manualLoop && index === activeIndex}
                          preload="auto"
                          onEnded={(e) => handleEnded(e.currentTarget, index)}
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
        /*
         * Suppress WebKit's native media UI on these decorative background
         * clips. macOS WKWebView paints a central "autoplay prevented" overlay
         * button on a <video> it won't autoplay; the primeVideo ref makes the
         * clip play, so this is belt-and-suspenders to keep that button from
         * flashing in the brief window before play() resolves. The clips are
         * pointer-events:none and never user-controlled.
         */
        .auth-carousel-swiper video::-webkit-media-controls,
        .auth-carousel-swiper video::-webkit-media-controls-overlay-play-button,
        .auth-carousel-swiper
          video::-webkit-media-controls-start-playback-button {
          display: none !important;
          -webkit-appearance: none;
        }
        /*
         * macOS WKWebView color-manages <video> to the display profile via
         * ColorSync, so the clip's dark background renders at a slightly
         * different tone than the CSS dark:bg-black-500 panel around it — a
         * visible rectangle where the video sits. Linux's WebKitGTK doesn't
         * color-manage the clip, so there it matches the panel exactly.
         *
         * Any CSS filter pulls the video off its CoreVideo display layer and
         * rasterizes it through a filter buffer, which is sRGB (CSS filter
         * operations are defined in sRGB). The clip's pixels are then composited
         * the same way as CSS colors, so the ColorSync tone shift disappears and
         * macOS matches Linux. saturate(0.99) is visually identity (a 1% change
         * is imperceptible) but non-trivial, so WebKit can't optimize the filter
         * — and its sRGB buffer — away.
         */
        .auth-carousel-swiper video {
          filter: saturate(0.99);
        }
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
