import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// The drive list is read in both themes, like every other surface. There are
// two pagers in the app and only one of them was written for dark mode; the
// other styles its page buttons with a light fill and no `dark:` counterpart,
// which renders as near-white pills on a dark page.
describe("the drive list's pager", () => {
  const list = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../FolderList.tsx"),
    "utf8",
  );

  it("is the one the files list uses", () => {
    expect(list).toContain('from "@/components/ui/table"');
    expect(list).not.toMatch(/import \{[^}]*Pagination[^}]*\} from "@\/components\/ui\/alt-table"/);
  });
});

// Fixed at the source too, so the surfaces still on it are not left with
// white pills on a dark page.
describe("the alt-table pager", () => {
  const pager = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../ui/alt-table/Pagination.tsx",
    ),
    "utf8",
  );

  it("styles its page buttons for dark mode as well as light", () => {
    expect(pager).toMatch(/dark:bg-/);
    expect(pager).toMatch(/dark:text-/);
  });
});
