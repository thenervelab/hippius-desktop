export type TBodyProps = React.HTMLAttributes<HTMLTableSectionElement>;

export const TBody: React.FC<TBodyProps> = ({
  children,
  className,
  ...rest
}) => (
  <tbody className={className} {...rest}>
    {children}
  </tbody>
);
