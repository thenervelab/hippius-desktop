import { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export type IconComponent = (props: IconProps) => ReactNode;
