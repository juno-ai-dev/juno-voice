import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

const body = <h2 id="modal-title">Test modal</h2>;

describe("Modal", () => {
  it("opens as a labelled modal dialog and closes from the close button", async () => {
    const onClose = vi.fn();
    render(<Modal titleId="modal-title" onClose={onClose}>{body}</Modal>);
    const dialog = screen.getByRole("dialog", { name: "Test modal" });
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("closes on the native cancel event (Escape) unless closing is disabled", () => {
    const onClose = vi.fn();
    const view = render(<Modal titleId="modal-title" onClose={onClose}>{body}</Modal>);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<Modal titleId="modal-title" onClose={onClose} closeDisabled>{body}</Modal>);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
  it("restores focus to the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<Modal titleId="modal-title" onClose={vi.fn()}>{body}</Modal>);
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
  it("supports the panel variant and a custom close label", () => {
    render(<Modal titleId="modal-title" onClose={vi.fn()} variant="panel" closeLabel="Close detail">{body}</Modal>);
    expect(screen.getByRole("dialog")).toHaveClass("modal-panel");
    expect(screen.getByRole("button", { name: "Close detail" })).toBeInTheDocument();
  });
});
