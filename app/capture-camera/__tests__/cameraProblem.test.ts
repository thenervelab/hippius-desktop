import { describe, expect, it } from "vitest";
import { problemFromAccess, problemFromError, problemText, type CameraProblem } from "../cameraProblem";

const err = (name: string) => Object.assign(new Error("x"), { name });

describe("why the bubble shows no camera", () => {
  it("reads Rust's answer: wait while asking, stop after a no, else open", () => {
    expect(problemFromAccess("asking")).toBe("asking");
    expect(problemFromAccess("denied")).toBe("notAllowed");
    expect(problemFromAccess("turnedOff")).toBe("turnedOff");
    expect(problemFromAccess("granted")).toBeNull();
    expect(problemFromAccess("unknown")).toBeNull();
    // macOS and Windows send nothing: the page opens the camera as before.
    expect(problemFromAccess(undefined)).toBeNull();
  });

  it("names getUserMedia's refusals by the error, not its message", () => {
    expect(problemFromError(err("NotAllowedError"))).toBe("notAllowed");
    expect(problemFromError(err("SecurityError"))).toBe("notAllowed");
    expect(problemFromError(err("NotFoundError"))).toBe("notFound");
    expect(problemFromError(err("OverconstrainedError"))).toBe("notFound");
    expect(problemFromError(err("NotReadableError"))).toBe("busy");
    expect(problemFromError(err("AbortError"))).toBe("busy");
    expect(problemFromError(err("TypeError"))).toBe("other");
    expect(problemFromError("thrown string")).toBe("other");
    expect(problemFromError(null)).toBe("other");
  });

  it("calls a refusal with no camera on the system what it is", () => {
    expect(problemFromError(err("NotAllowedError"), false)).toBe("notFound");
    expect(problemFromError(err("NotAllowedError"), true)).toBe("notAllowed");
    expect(problemFromError(err("NotAllowedError"), null)).toBe("notAllowed");
  });

  it("says what to do for every problem, in plain words without em dashes", () => {
    const all: CameraProblem[] = ["asking", "notAllowed", "turnedOff", "notFound", "busy", "noPicture", "unsupported", "other"];
    for (const p of all) {
      const { title, hint } = problemText(p, "Settings, Privacy, Camera");
      expect(title.length).toBeGreaterThan(0);
      expect(hint.length).toBeGreaterThan(0);
      expect(title + hint).not.toContain("\u2014");
    }
    expect(problemText("notAllowed", "System Settings, Privacy & Security, Camera").hint).toBe(
      "Allow Hippius in System Settings, Privacy & Security, Camera, then turn the camera off and on again.",
    );
    // Without Rust's place the line still says where to look.
    expect(problemText("notAllowed").hint).toContain("privacy settings");
  });
});
