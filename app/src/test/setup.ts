import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// findBy*/waitFor default to 1s, which flakes on loaded CI machines.
configure({ asyncUtilTimeout: 5_000 });

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
  () =>
    ({
      measureText: (text: string) => ({ width: text.length * 8 }),
    }) as unknown as CanvasRenderingContext2D,
);

// jsdom logs "Not implemented" for window.scrollTo, which the app calls on
// page navigation.
window.scrollTo = () => {};

// jsdom 26 implements only the `open` property of HTMLDialogElement. Give the
// Modal component workable showModal/close; real focus trapping, Escape, and
// backdrop behavior are asserted in Playwright.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

afterEach(cleanup);
