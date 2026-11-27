import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ViewerIdentity, viewerIdentity } from "../ViewerIdentity";
import { ANONYMOUS, avatarFor, initials } from "../insightsView";

describe("who a viewer is", () => {
  it("is the name with the email under it, the email alone, or Anonymous viewer", () => {
    expect(viewerIdentity("Dana Reyes", "dana@acme.com")).toEqual({ primary: "Dana Reyes", secondary: "dana@acme.com", avatar: "Dana Reyes" });
    expect(viewerIdentity(null, "dana@acme.com")).toEqual({ primary: "dana@acme.com", secondary: null, avatar: "dana@acme.com" });
    expect(viewerIdentity("  ", undefined)).toEqual({ primary: ANONYMOUS, secondary: null, avatar: null });
    // A name that is the email again is said once.
    expect(viewerIdentity("Dana@acme.com", "dana@acme.com").secondary).toBeNull();
  });

  it("takes initials from an email's name part when there is no name", () => {
    expect(initials("maya.chen@acme.com")).toBe("MC");
    expect(initials("alice+deals@acme.com")).toBe("A");
    expect(avatarFor("maya.chen@acme.com")?.initials).toBe("MC");
  });

  it("draws an email-only viewer by the email, whole, with initials, never as anonymous", () => {
    render(<ViewerIdentity name={null} email="alexander.r@acme.com" />);
    const line = screen.getByTestId("viewer-primary");
    expect(line).toHaveTextContent("alexander.r@acme.com");
    expect(line).toHaveAttribute("title", "alexander.r@acme.com");
    expect(screen.queryByText(ANONYMOUS)).toBeNull();
    expect(screen.getByTestId("insights-avatar")).toHaveTextContent("AR");
  });

  it("puts the email under the name", () => {
    render(<ViewerIdentity name="Alex Rivers" email="alex@acme.com" />);
    expect(screen.getByTestId("viewer-primary")).toHaveTextContent("Alex Rivers");
    expect(screen.getByTestId("viewer-email")).toHaveTextContent("alex@acme.com");
    expect(screen.getByTestId("viewer-email")).toHaveAttribute("title", "alex@acme.com");
  });
});
