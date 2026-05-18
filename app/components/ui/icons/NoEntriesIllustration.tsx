import { SVGProps, ReactNode } from "react";

export const NoEntriesIllustration = ({
  className,
}: SVGProps<SVGSVGElement>): ReactNode => (
  <img
    src="/light-no-found.png"
    alt=""
    width={87}
    height={90}
    className={className}
  />
);

export default NoEntriesIllustration;
