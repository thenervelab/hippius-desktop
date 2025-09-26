import pricingJson from "@/app/utils/data/pricing-cfg.json";

export type PricingData = typeof pricingJson;

export type PricingTypes = keyof PricingData["storage"];
export const TIMING_OPTIONS = ["first-hour", "per-month", "per-year"] as const;

export const DEFAULT_TIMING_OPTION: PricingTimingOptions = "per-month";

export type PricingTimingOptions = (typeof TIMING_OPTIONS)[number];

export const TIMING_OPTION_DATA: Record<
  PricingTimingOptions,
  {
    duration: number;
    label: string;
    extraDetail?: string;
  }
> = {
  "first-hour": {
    duration: 3600,
    label: "first hour",
  },

  "per-month": {
    duration: 2.628e6,
    label: "month",
    extraDetail: "This is a rough monthly estimate",
  },
  "per-year": {
    duration: 3.154e7,
    label: "year",
    extraDetail: "This is a rough annual estimate",
  },
};

export const calculateStorageCost = (data: {
  storageTypeData: PricingData["storage"]["ipfs"];
  perBlockTime: PricingData["per_block_time_s"];
  timeframe: PricingTimingOptions;
  numOfGb: number;
}) => {
  const { storageTypeData, perBlockTime, timeframe, numOfGb } = data;

  const firstHourCost = storageTypeData.first_hour_charge * numOfGb;

  const timeframeMinusFirstHour =
    TIMING_OPTION_DATA[timeframe].duration -
    TIMING_OPTION_DATA["first-hour"]["duration"];

  const singleBlockCharge = storageTypeData.per_block_charge * numOfGb;

  const blockChargeCount = timeframeMinusFirstHour / perBlockTime;

  const subsequentTimeCost = singleBlockCharge * blockChargeCount;

  return firstHourCost + subsequentTimeCost;
};
