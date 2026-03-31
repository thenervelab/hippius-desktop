import { SVGProps, ReactNode } from "react";

export const Globe = ({ className }: SVGProps<SVGSVGElement>): ReactNode => (
  <img src="/illustrations/globe.svg" alt="" className={className} />
);
export default Globe;
