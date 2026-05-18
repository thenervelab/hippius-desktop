import { SVGProps, ReactNode } from "react";

export const NoEntriesIllustrationDark = ({
  className,
}: SVGProps<SVGSVGElement>): ReactNode => (
  <img
    src="/dark-no-found.png"
    alt=""
    width={87}
    height={90}
    className={className}
  />
);

export default NoEntriesIllustrationDark;
