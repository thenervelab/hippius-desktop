type Data = {
  totalPages: number;
  currentPage: number;
  window?: number[];
};

// TODO - Add prop to customise the number of digits to show outside the window before adding delims???
// TODO - Ability to customise delimiter position

export const DEFAULT_PAGINATION_WINDOW = [-1, 0, 1];

export const getPaginationPageList = (data: Data) => {
  const {
    totalPages,
    currentPage,
    window: paginationWindow = DEFAULT_PAGINATION_WINDOW,
  } = data;

  if (!currentPage || !totalPages) return [];

  // Gets page numbers bound by 1 and total pages
  const pages = paginationWindow
    .map((v) => currentPage + v, totalPages)
    .filter((v) => v > 0)
    .filter((v) => v <= totalPages);

  const first = pages[0];
  const last = pages[pages.length - 1];

  // Add delimiters
  const pagesSet = new Set([
    1, // First page
    Math.sign(Math.max(first - 1 - 1, 0)) * -1, // Evaluates to -1 or 0 to get first delim. Will filter out zeros later
    ...pages, // pages
    Math.sign(Math.max(totalPages - last - 1, 0)) * -2, // Evaluates to -2 or 0 to get last delim. Will filter out zeros later
    totalPages, // last page
  ]);

  // Remove zeros and convert -2 to -1
  const finalArray = Array.from(pagesSet).reduce((a, b) => {
    if (b === 0) {
      return a;
    } else if (b === -2) {
      // TODO - consider leaving the -2 in as it gives more information
      a.push(-1);
    } else {
      a.push(b);
    }
    return a;
  }, [] as number[]);

  return finalArray;
};
