export type BaseLinkData = {
  label: string;
  href: string;
  exact?: boolean;
  newTab?: boolean;
};

export type NavLink<T = "link" | "dropdown"> = T extends "link"
  ? { type: T } & BaseLinkData
  : {
      type: T;
      label: BaseLinkData["label"];
      links: BaseLinkData[];
    };
