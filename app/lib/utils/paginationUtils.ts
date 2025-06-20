/**
 * Generates an array of page numbers and ellipses for pagination
 * @param currentPage - Current active page number (1-indexed)
 * @param pageCount - Total number of pages
 * @returns Array containing page numbers and "..." strings for ellipses
 */
export function generateDesktopPaginationArray(
  currentPage: number,
  pageCount: number
): (number | string)[] {
  const pages: (number | string)[] = [];

  // Show all pages if pageCount is 5 or less
  if (pageCount <= 5) {
    for (let i = 1; i <= pageCount; i++) pages.push(i);
  }
  // Show ellipses when there are more than 5 pages
  else {
    // Always show first page
    pages.push(1);

    // Near the beginning of pagination
    if (currentPage <= 3) {
      pages.push(2, 3);
      // Always show page 4 if we're at page 3
      if (currentPage === 3 && pageCount >= 4) {
        pages.push(4);
      }
      if (pageCount > (currentPage === 3 ? 5 : 4)) pages.push("...");
      pages.push(pageCount);
    }
    // Near the end of pagination
    else if (currentPage >= pageCount - 1) {
      pages.push("...");
      // Ensure we show at least 3 pages before the end
      pages.push(pageCount - 2, pageCount - 1, pageCount);
    }
    // Middle case
    else {
      pages.push("...");
      pages.push(currentPage - 1, currentPage, currentPage + 1);
      if (pageCount > currentPage + 2) pages.push("...");
      if (currentPage < pageCount - 1) pages.push(pageCount);
    }
  }

  return pages;
}

/**
 * Generates a simplified array of page numbers for mobile pagination
 * @param currentPage - Current active page number (1-indexed)
 * @param pageCount - Total number of pages
 * @returns Array containing minimal page numbers and "..." strings for ellipses
 */
export function generateMobilePaginationArray(
  currentPage: number,
  pageCount: number
): (number | string)[] {
  const pages: (number | string)[] = [];

  // Show all pages if pageCount is 3 or less
  if (pageCount <= 3) {
    for (let i = 1; i <= pageCount; i++) pages.push(i);
    return pages;
  }

  // Show first page if not current page
  if (currentPage > 1) {
    pages.push(1);
  }

  // If current page is not adjacent to first page, add ellipsis or the page before
  if (currentPage > 2) {
    pages.push(currentPage === 3 ? 2 : "...");
  }

  // Always show current page
  pages.push(currentPage);

  // If current page is not adjacent to last page, add ellipsis or the page after
  if (currentPage < pageCount - 1) {
    pages.push(currentPage === pageCount - 2 ? pageCount - 1 : "...");
  }

  // Show last page if not current page
  if (currentPage < pageCount) {
    pages.push(pageCount);
  }

  return pages;
}
