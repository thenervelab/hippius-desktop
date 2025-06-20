import { useMemo, useState } from "react";

export const usePagination = <T>(data: T[], limit: number) => {
  const [currentPage, setCurrentPage] = useState(1);

  const paginationData = useMemo(() => {
    return {
      paginatedData: data.slice((currentPage - 1) * limit, currentPage * limit),
      totalPages: Math.ceil(data.length / limit),
    };
  }, [limit, data, currentPage]);

  return {
    setCurrentPage,
    currentPage,
    ...paginationData,
  };
};

export default usePagination;
