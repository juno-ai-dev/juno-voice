import { useEffect, useRef, type ReactNode } from "react";
import "./modal.css";

// Route- and state-driven overlays share this one top-layer <dialog>. The
// browser supplies focus containment, Escape (the cancel event), and the
// backdrop; focus restoration to the opener is explicit because closing via
// navigation can unmount the dialog without a native close.
export function Modal({ titleId, onClose, variant = "dialog", closeDisabled = false, closeLabel = "Close", children }: {
  titleId: string;
  onClose: () => void;
  variant?: "dialog" | "panel";
  closeDisabled?: boolean;
  closeLabel?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // showModal focuses the first focusable element (the close button), which
    // paints a focus ring on every open. Start on the frame instead.
    frameRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={`modal modal-${variant}`}
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }}
      onClick={(event) => { if (event.target === dialogRef.current && !closeDisabled) onClose(); }}
    >
      <div className="modal-frame" ref={frameRef} tabIndex={-1}>
        <button type="button" className="button secondary modal-close" onClick={onClose} disabled={closeDisabled}>{closeLabel}</button>
        {children}
      </div>
    </dialog>
  );
}
