import { cn } from "@/app/lib/utils";

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
  className,
  ...rest
}) => (
  <input
    className={cn("border border-grey-80 rounded-lg py-3 px-4", className)}
    {...rest}
  />
);

export default Input;
