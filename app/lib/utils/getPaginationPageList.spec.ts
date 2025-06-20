import { describe, it, expect } from "vitest";
import { getPaginationPageList } from "./getPaginationPageList";

describe("test getPaginationPageList works", () => {
  it("works when we don't expect any delims various cases", () => {
    expect(
      getPaginationPageList({
        totalPages: 1,
        currentPage: 1,
      })
    ).toEqual([1]);

    expect(
      getPaginationPageList({
        totalPages: 5,
        currentPage: 3,
      })
    ).toEqual([1, 2, 3, 4, 5]);

    expect(
      getPaginationPageList({
        totalPages: 5,
        currentPage: 2,
        window: [-1, 0, 1, 2],
      })
    ).toEqual([1, 2, 3, 4, 5]);

    expect(
      getPaginationPageList({
        totalPages: 5,
        currentPage: 2,
        window: [-1, 0, 1, 3],
      })
    ).toEqual([1, 2, 3, 5]);
  });

  it("Works with 1 delimiter", () => {
    expect(
      getPaginationPageList({
        totalPages: 5,
        currentPage: 2,
      })
    ).toEqual([1, 2, 3, -1, 5]);
    expect(
      getPaginationPageList({
        totalPages: 21,
        currentPage: 2,
      })
    ).toEqual([1, 2, 3, -1, 21]);
  });

  it("Works when there are 2 delimiters", () => {
    expect(
      getPaginationPageList({
        totalPages: 10,
        currentPage: 5,
      })
    ).toEqual([1, -1, 4, 5, 6, -1, 10]);

    expect(
      getPaginationPageList({
        totalPages: 100,
        currentPage: 5,
      })
    ).toEqual([1, -1, 4, 5, 6, -1, 100]);
  });
});
