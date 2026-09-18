import { describe, it, expect } from "vitest";
import {
  FOLDER_LIST_PAGE_SIZE,
  resolveFolderListPage,
} from "../folderListPaging";

describe("resolveFolderListPage", () => {
  it("draws no pager while everything fits on one page", () => {
    const view = resolveFolderListPage({ total: FOLDER_LIST_PAGE_SIZE, page: 1 });
    expect(view.showPager).toBe(false);
    expect(view.totalPages).toBe(1);
    expect(view.end).toBe(FOLDER_LIST_PAGE_SIZE);
  });

  it("pages once the list outgrows a page", () => {
    const view = resolveFolderListPage({ total: 20, page: 2, pageSize: 8 });
    expect(view.showPager).toBe(true);
    expect(view.totalPages).toBe(3);
    expect(view.start).toBe(8);
    expect(view.end).toBe(16);
  });

  it("gives the last page only the rows that are left", () => {
    const view = resolveFolderListPage({ total: 20, page: 3, pageSize: 8 });
    expect(view.start).toBe(16);
    expect(view.end).toBe(20);
  });

  // Removing the last drive on the last page leaves the caller pointing past
  // the end. An out-of-range page renders an empty list under a pager that
  // says there are drives, which reads as the list having broken.
  it("clamps a page that is now past the end", () => {
    const view = resolveFolderListPage({ total: 9, page: 5, pageSize: 8 });
    expect(view.page).toBe(2);
    expect(view.start).toBe(8);
    expect(view.end).toBe(9);
  });

  it.each([0, -3, Number.NaN])("treats %s as the first page", (page) => {
    expect(resolveFolderListPage({ total: 20, page, pageSize: 8 }).page).toBe(1);
  });

  it("survives an empty list", () => {
    const view = resolveFolderListPage({ total: 0, page: 1 });
    expect(view).toMatchObject({ page: 1, totalPages: 1, start: 0, end: 0, showPager: false });
  });

  it("never divides by a zero page size", () => {
    const view = resolveFolderListPage({ total: 5, page: 1, pageSize: 0 });
    expect(Number.isFinite(view.totalPages)).toBe(true);
    expect(view.end).toBe(1);
  });
});
