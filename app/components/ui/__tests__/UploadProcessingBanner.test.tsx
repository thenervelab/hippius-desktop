import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import UploadProcessingBanner from "../UploadProcessingBanner";
import { uploadProcessingAtom } from "@/lib/global-atoms/uploadProcessingAtoms";

function renderWithState(active: boolean, pendingFiles: number) {
  const store = createStore();
  store.set(uploadProcessingAtom, { active, pendingFiles });
  return render(
    <Provider store={store}>
      <UploadProcessingBanner />
    </Provider>
  );
}

describe("UploadProcessingBanner", () => {
  it("renders nothing when inactive", () => {
    const { container } = renderWithState(false, 0);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders count + label when active with N > 1", () => {
    renderWithState(true, 47);
    expect(screen.getByText(/Processing 47 files/i)).toBeInTheDocument();
    expect(screen.getByText(/Sync will start shortly/i)).toBeInTheDocument();
  });

  it("uses singular noun when count is 1", () => {
    renderWithState(true, 1);
    expect(screen.getByText(/Processing 1 file\b/i)).toBeInTheDocument();
  });

  it("falls back to generic copy when count is 0", () => {
    renderWithState(true, 0);
    expect(screen.getByText(/Processing your files/i)).toBeInTheDocument();
  });
});
