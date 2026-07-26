import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Vitest does not enable `globals`, so RTL's auto-cleanup isn't registered — unmount rendered
// components after each test, otherwise multiple renders accumulate in the DOM and queries throw
// "found multiple elements".
afterEach(() => {
  cleanup();
});

// jsdom does not implement <dialog>'s showModal()/close() (see jsdom/jsdom#3294 — jsdom's
// HTMLDialogElement is an empty stub extending HTMLElement, closed won't-fix upstream). Polyfill
// just enough of the native behavior for components that call showModal()/close() to work under
// Vitest: toggle the `open` attribute and fire the `close` event .close() dispatches natively.
// (The `cancel` event used for Escape-to-cancel is fired directly by tests via fireEvent, so it
// needs no polyfill here.) Guarded on `typeof` because some test files opt into the `node`
// environment (via `// @vitest-environment node`), where HTMLDialogElement doesn't exist at all.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}
