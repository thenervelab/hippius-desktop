import { SVGProps, ReactNode } from "react";

export const NoCreditsIllustrationDark = ({
  className,
}: SVGProps<SVGSVGElement>): ReactNode => (
  <img
    src="/dark-no-credit-found.png"
    alt=""
    width={87}
    height={73}
    className={className}
  />
);

export default NoCreditsIllustrationDark;
