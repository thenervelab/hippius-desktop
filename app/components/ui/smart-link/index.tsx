'use client';

import Link from "next/link";
import React from "react";

type Props = {
  href: string;
  newTab?: boolean;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
};

const SmartLink: React.FC<Props> = ({ href, newTab, className, onClick, children }) => {
  if (newTab) {
    return (
      <a
        href={href}
        className={className}
        onClick={onClick}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
};

export default SmartLink;
