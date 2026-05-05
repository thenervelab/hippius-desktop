import React from "react";
import { InView } from "react-intersection-observer";
import { SWIPE_CONTENT } from "./SwipeContent";
import { Swiper, SwiperSlide } from "swiper/react";
import { Pagination, Autoplay } from "swiper/modules";
import "swiper/css";
import "swiper/css/pagination";

const LeftCarouselPanel = () => {
  return (
    <div className="relative w-full h-full min-h-full max-h-full rounded-[11px] bg-grey-light-200 dark:bg-black-500 overflow-hidden">
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref} className="w-full h-full min-h-full max-h-full ">
            <Swiper
              modules={[Pagination, Autoplay]}
              pagination={{
                clickable: true,
                bulletClass: "swiper-pagination-bullet auth-carousel-bullet",
                bulletActiveClass:
                  "swiper-pagination-bullet-active auth-carousel-bullet-active",
              }}
              autoplay={{
                delay: 6000,
                disableOnInteraction: true,
                pauseOnMouseEnter: true,
              }}
              className="auth-carousel-swiper w-full h-full"
            >
              {SWIPE_CONTENT.map((item) => (
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
                      <img
                        src={item.image}
                        alt={item.title}
                        className="absolute left-0 top-1/2 -translate-y-[57%] w-full h-auto block select-none pointer-events-none dark:hidden"
                        draggable={false}
                      />
                      <img
                        src={item.imageDark}
                        alt={item.title}
                        className="absolute left-0 top-1/2 -translate-y-[57%] w-full h-auto hidden select-none pointer-events-none dark:block"
                        draggable={false}
                      />
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
        @media (prefers-color-scheme: dark) {
          .auth-carousel-bullet {
            background: #ebebeb !important;
          }
        }
      `}</style>
    </div>
  );
};

export default LeftCarouselPanel;
