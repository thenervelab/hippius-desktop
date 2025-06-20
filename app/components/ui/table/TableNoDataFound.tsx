"use client";

import React from "react";

interface TableNoResultProps {
  colSpan: number;
  message?: string;
}

export const TableNoDataFound: React.FC<TableNoResultProps> = ({
  colSpan,
  message = "No data found.",
}) => {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="py-4 text-center text-gray-500 font-grotesk text-sm"
      >
        {message}
      </td>
    </tr>
  );
};
