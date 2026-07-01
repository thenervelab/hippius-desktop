import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAddressValidation } from "@/app/lib/hooks/useAddressValidation";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);

beforeEach(() => tauri.reset());

describe("useAddressValidation", () => {
  it("rejects an empty address without calling the backend", async () => {
    const { result } = renderHook(() => useAddressValidation());

    let valid = true;
    await act(async () => {
      valid = await result.current.validateAddress();
    });

    expect(valid).toBe(false);
    expect(result.current.addressError).toBe("Address is required");
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("rejects an address the backend reports invalid", async () => {
    tauri.onInvoke("validate_address", () => false);
    const { result } = renderHook(() => useAddressValidation());

    act(() => result.current.setAddress("bad"));
    let valid = true;
    await act(async () => {
      valid = await result.current.validateAddress();
    });

    expect(valid).toBe(false);
    expect(result.current.addressError).toBe("Invalid address format");
    expect(tauri.core.invoke).toHaveBeenCalledWith("validate_address", { address: "bad" });
  });

  it("rejects the disallowed (self) address with the custom message", async () => {
    tauri.onInvoke("validate_address", () => true);
    const { result } = renderHook(() =>
      useAddressValidation({
        disallowedAddress: "5self",
        disallowedAddressMessage: "Can't send to yourself",
      })
    );

    act(() => result.current.setAddress("5self"));
    let valid = true;
    await act(async () => {
      valid = await result.current.validateAddress();
    });

    expect(valid).toBe(false);
    expect(result.current.addressError).toBe("Can't send to yourself");
  });

  it("accepts a valid, allowed address and clears the error", async () => {
    tauri.onInvoke("validate_address", () => true);
    const { result } = renderHook(() =>
      useAddressValidation({ disallowedAddress: "5self" })
    );

    act(() => result.current.setAddress("5other"));
    let valid = false;
    await act(async () => {
      valid = await result.current.validateAddress();
    });

    expect(valid).toBe(true);
    expect(result.current.addressError).toBeUndefined();
  });

  it("handleAddressChange clears a standing error on the next keystroke", async () => {
    const { result } = renderHook(() => useAddressValidation());

    await act(async () => {
      await result.current.validateAddress(); // sets "Address is required"
    });
    expect(result.current.addressError).toBe("Address is required");

    act(() => result.current.handleAddressChange("5abc"));
    expect(result.current.address).toBe("5abc");
    expect(result.current.addressError).toBeUndefined();
  });
});
