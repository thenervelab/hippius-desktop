"use client";

import { useEffect } from "react";

import { useAbstractCity } from "@/app/lib/hooks";

import AbstractCity from "./AbstractCity";
import { AbstractCityData } from "@/app/lib/hooks/use-abstract-city/types";

const AbstractCityContainer: React.FC<
  { onLoad?: () => void } & Partial<AbstractCityData>
> = ({ onLoad, ...hookProps }) => {
  const { loaded, ...rest } = useAbstractCity(hookProps);

  useEffect(() => {
    if (loaded && onLoad) {
      onLoad();
    }
  }, [loaded, onLoad]);

  return (
    <AbstractCity animate={!!hookProps.animate} loaded={loaded} {...rest} />
  );
};

export default AbstractCityContainer;
