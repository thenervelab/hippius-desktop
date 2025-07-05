import React from "react";
import { LoginRightBottom } from "@/components/ui/icons";
import { Graphsheet, RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import { SWIPE_CONTENT } from "./SwipeContent";
import { Swiper, SwiperSlide } from "swiper/react";
import { Pagination, Autoplay } from "swiper/modules";
import "swiper/css";
import "swiper/css/pagination";

const LeftCarouselPanel = () => {
  return (
    <div className="relative w-full h-full min-h-full max-h-full rounded-lg bg-primary-50">
      <div className="absolute w-full top-0 h-full opacity-5">
        <Graphsheet
          majorCell={{
            lineColor: [255, 255, 255, 1.0],
            lineWidth: 2,
            cellDim: 150,
          }}
          minorCell={{
            lineColor: [255, 255, 255, 1.0],
            lineWidth: 1,
            cellDim: 15,
          }}
          className="absolute w-full left-0 h-full min-h-full max-h-full duration-500"
        />
      </div>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="w-full h-full min-h-full max-h-full relative z-100"
          >
            <Swiper
              modules={[Pagination, Autoplay]}
              pagination={{ clickable: true }}
              autoplay={{ delay: 3000, disableOnInteraction: false }}
              className="w-full h-full"
            >
              {SWIPE_CONTENT.map((item) => (
                <SwiperSlide key={item.heading}>
                  <div className="py-[84px] px-5 w-full h-full items-center  flex  justify-between flex-col">
                    <RevealTextLine
                      rotate
                      reveal={inView}
                      className="delay-300 w-full"
                    >
                      <div
                        className="text-center xl:text-[40px] text-[28px] 
                      font-medium text-grey-100 mb-12  "
                      >
                        {item.heading}
                      </div>
                    </RevealTextLine>
                    <div className="w-full flex items-center justify-center">
                      {item.icon}
                    </div>
                    <div className="flex flex-col gap-1 items-center justify-center font-normal mt-10 w-full px-10 relative z-30">
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        className="delay-300"
                      >
                        <span className="text-[22px] text-center text-grey-100">
                          {item.text}
                        </span>
                      </RevealTextLine>
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        className="delay-500"
                      >
                        <p className="text-sm text-center text-grey-80">
                          {item.subText}
                        </p>
                      </RevealTextLine>
                    </div>
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
            <div className="absolute right-0 bottom-0 w-full z-0">
              <LoginRightBottom className="w-full h-[280px]" />
            </div>
          </div>
        )}
      </InView>
    </div>
  );
};

export default LeftCarouselPanel;
