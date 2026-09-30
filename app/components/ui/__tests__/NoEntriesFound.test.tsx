import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import NoEntriesFound from "../NoEntriesFound";

describe("NoEntriesFound optional parts", () => {
  it("draws a given illustration in place of the default one, and names the title", () => {
    render(
      <section aria-labelledby="empty-title">
        <NoEntriesFound
          title="A place"
          description="Words"
          titleId="empty-title"
          illustration={<svg data-testid="custom-art" />}
        />
      </section>,
    );
    expect(screen.getByTestId("custom-art")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "A place" })).toBeInTheDocument();
  });

  it("shows a footer link under the button", () => {
    render(
      <NoEntriesFound
        title="t"
        description="d"
        buttonText="Go"
        onButtonClick={() => undefined}
        footerLink={<a href="#docs">Docs</a>}
      />,
    );
    expect(screen.getByRole("button", { name: /Go/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toBeInTheDocument();
  });

  it("shows the footer for a link alone, with no button", () => {
    render(<NoEntriesFound title="t" description="d" footerLink={<a href="#docs">Docs</a>} />);
    expect(screen.getByRole("link", { name: "Docs" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders as before without the new props", () => {
    render(<NoEntriesFound title="t" description="d" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
