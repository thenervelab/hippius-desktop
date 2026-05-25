"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const HEIGHT_TRANSITION = {
  type: "tween" as const,
  duration: 0.25,
  ease: [0.25, 0.1, 0.25, 1] as const,
};

const OPACITY_TRANSITION = {
  type: "tween" as const,
  duration: 0.2,
  ease: "easeInOut" as const,
};

export interface AccordionColumn {
  id: string;
  widthPercent?: number;
}

interface AnimatedTableAccordionProps {
  isExpanded: boolean;
  colSpan: number;
  children: React.ReactNode;
  tableClassName?: string;
  /**
   * Column descriptors for the inner table's <colgroup>. When provided
   * the inner table will lay out its columns using the same percentages
   * as the outer table, so vertical borders line up exactly with the
   * parent header — independent of any per-cell width hints.
   */
  columns?: AccordionColumn[];
}

function AccordionContent({
  colSpan,
  children,
  tableClassName,
  columns,
}: Omit<AnimatedTableAccordionProps, "isExpanded">) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setMeasuredHeight(entry.contentRect.height);
      }
    });

    observer.observe(element);
    setMeasuredHeight(element.scrollHeight);

    return () => observer.disconnect();
  }, []);

  return (
    <tr aria-hidden={false}>
      <motion.td
        colSpan={colSpan}
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: measuredHeight, opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{
          height: HEIGHT_TRANSITION,
          opacity: OPACITY_TRANSITION,
        }}
        style={{
          padding: 0,
          border: 0,
          lineHeight: 0,
          overflow: "hidden",
          display: "table-cell",
        }}
      >
        <div ref={contentRef}>
          <table
            className={
              tableClassName ??
              "w-full table-fixed border-collapse whitespace-nowrap"
            }
            style={{ borderSpacing: 0 }}
          >
            {columns && columns.length > 0 ? (
              <colgroup>
                {columns.map((col) => (
                  <col
                    key={col.id}
                    style={
                      col.widthPercent
                        ? { width: `${col.widthPercent}%` }
                        : undefined
                    }
                  />
                ))}
              </colgroup>
            ) : null}
            <tbody>{children}</tbody>
          </table>
        </div>
      </motion.td>
    </tr>
  );
}

export function AnimatedTableAccordion({
  isExpanded,
  colSpan,
  children,
  tableClassName,
  columns,
}: AnimatedTableAccordionProps) {
  return (
    <AnimatePresence initial={false}>
      {isExpanded ? (
        <AccordionContent
          colSpan={colSpan}
          tableClassName={tableClassName}
          columns={columns}
        >
          {children}
        </AccordionContent>
      ) : null}
    </AnimatePresence>
  );
}
