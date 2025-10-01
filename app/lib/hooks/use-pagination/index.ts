import { useMemo, useState, useEffect, useRef } from "react";

export const usePagination = <T>(data: T[], limit: number) => {
  const [currentPage, setCurrentPage] = useState(1);
  
  // Keep track of previous data length and source signatures to detect significant changes
  const prevDataLengthRef = useRef<number>(data.length);
  const prevDataSignatureRef = useRef<string>("");
  
  // Create a data signature to detect when the data source has fundamentally changed
  // This helps us detect changes between different views (private/public)
  const dataSignature = useMemo(() => {
    if (data.length === 0) return "";
    
    // Sample a few items to create a signature
    const samples: unknown[] = [];
    
    // Take samples from start, middle, and end
    samples.push(data[0]);
    if (data.length > 2) samples.push(data[Math.floor(data.length / 2)]);
    if (data.length > 1) samples.push(data[data.length - 1]);
    
    // Create a string signature based on these samples
    return samples
      .map(item => JSON.stringify(item).substring(0, 50))
      .join('|');
  }, [data]);

  // Reset to first page when data changes significantly
  useEffect(() => {
    const dataLengthChanged = Math.abs(data.length - prevDataLengthRef.current) > 5;
    const dataSourceChanged = dataSignature !== prevDataSignatureRef.current && prevDataSignatureRef.current !== "";
    
    if (dataLengthChanged || dataSourceChanged) {
      console.log('Data source changed significantly, resetting pagination to page 1');
      setCurrentPage(1);
    }
    
    // Always update our refs
    prevDataLengthRef.current = data.length;
    prevDataSignatureRef.current = dataSignature;
  }, [data.length, dataSignature]);

  // Ensure currentPage is valid for the current data length
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(data.length / limit));
    if (currentPage > maxPage) {
      console.log(`Current page ${currentPage} exceeds max page ${maxPage}, resetting to page 1`);
      setCurrentPage(1);
    }
  }, [currentPage, data.length, limit]);

  const paginationData = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(data.length / limit));
    const validPage = Math.min(currentPage, totalPages || 1);
    const start = (validPage - 1) * limit;
    const end = Math.min(start + limit, data.length);
    
    return {
      paginatedData: data.slice(start, end),
      totalPages: totalPages,
    };
  }, [limit, data, currentPage]);

  return {
    setCurrentPage,
    currentPage,
    ...paginationData,
  };
};

export default usePagination;
