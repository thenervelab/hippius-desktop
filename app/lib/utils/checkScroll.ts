export const checkScroll = <T extends HTMLElement>(element: T) => {
  const scrollTop = element.scrollTop;
  const scrollHeight = element.scrollHeight;
  const clientHeight = element.clientHeight;

  return {
    canScrollUp: scrollTop > 0,
    canScrollDown: scrollTop + clientHeight < scrollHeight - 1,
  };
};
