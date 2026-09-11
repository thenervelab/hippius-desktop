import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, createEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import AppContextMenu from "../AppContextMenu";
import {
  pageContextActionsAtom,
  type PageContextActions,
} from "@/app/lib/global-atoms/contextMenuAtoms";

/**
 * Mount the menu with a given registration, and return the store so a
 * test can change it afterwards.
 */
const mount = (actions: PageContextActions | null) => {
  const store = createStore();
  store.set(pageContextActionsAtom, actions);
  const view = render(
    <Provider store={store}>
      <AppContextMenu />
    </Provider>,
  );
  return { store, view };
};

/**
 * Right-click somewhere with no row or card menu of its own.
 *
 * Dispatched through `fireEvent` rather than `dispatchEvent`: the menu
 * listens on `document`, and a state update from a raw native event is
 * not wrapped in `act`, so the menu would never be rendered by the time
 * the assertion runs.
 */
const rightClickBackground = () => {
  const event = createEvent.contextMenu(document.body, { clientX: 40, clientY: 40 });
  fireEvent(document.body, event);
  return event;
};

describe("the right-click menu only appears where files live", () => {
  /**
   * The bug this covers: New Folder was pushed into the list
   * unconditionally, so a page that registered nothing still opened a
   * menu — a single New Folder item, on Settings, Security, Notifications
   * and everywhere else that has no folders at all.
   */
  it("opens no menu on a page that registered nothing", () => {
    mount(null);
    rightClickBackground();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("New Folder")).not.toBeInTheDocument();
  });

  // And it must leave the event alone, or the OS menu is suppressed on
  // every page in the app for no benefit.
  it("does not swallow the right-click there", () => {
    mount(null);
    const event = rightClickBackground();
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens on a surface that did register", () => {
    mount({});
    const event = rightClickBackground();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("New Folder")).toBeInTheDocument();
    // Taking the event is what replaces the WebView's developer menu.
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * An empty registration is still a registration: a browsed drive offers
   * no local uploads but New Folder works there, so `{}` must not be read
   * as "no menu".
   */
  it("lists only what the surface registered", () => {
    mount({ onUploadFile: () => {} });
    rightClickBackground();
    expect(screen.getByText("Upload File")).toBeInTheDocument();
    expect(screen.getByText("New Folder")).toBeInTheDocument();
    expect(screen.queryByText("Upload Folder")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync a Folder")).not.toBeInTheDocument();
  });

  // Navigating away unregisters. A menu left floating would run the
  // previous page's handlers over the new page.
  it("closes when the surface unregisters", () => {
    const { store } = mount({});
    rightClickBackground();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => store.set(pageContextActionsAtom, null));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("the menu yields to what already handles the click", () => {
  it("leaves a row or card menu alone", () => {
    mount({});
    const event = createEvent.contextMenu(document.body);
    event.preventDefault();
    fireEvent(document.body, event);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * Right-clicking a text field must still offer Cut / Copy / Paste.
   * Replacing that with folder actions takes away the only way to copy a
   * wallet address with the mouse.
   */
  it("leaves text fields to the OS menu", () => {
    mount({});
    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = createEvent.contextMenu(input);
    fireEvent(input, event);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });
});
