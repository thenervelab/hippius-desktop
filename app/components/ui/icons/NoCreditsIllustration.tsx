import { SVGProps, ReactNode } from "react";

export const NoCreditsIllustration = ({
  className,
}: SVGProps<SVGSVGElement>): ReactNode => (
  <img
    src="/light-no-credit-found.png"
    alt=""
    width={87}
    height={73}
    className={className}
  />
);

export default NoCreditsIllustration;
