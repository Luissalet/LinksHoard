import React, { useEffect, useRef, useState } from "react";

export function Page({ title, description, actions, children }) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-8 sm:py-9">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight sm:text-[30px]">{title}</h1>
          {description && <p className="help mt-1 max-w-[70ch] text-[13px]">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Section({ title, aside, children, className = "" }) {
  return (
    <section className={`panel-white ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-[17px] font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ text, action }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center" style={{ borderColor: "var(--field-line)" }}>
      <p className="help mb-3">{text}</p>
      {action}
    </div>
  );
}

export function Field({ label, help, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {help && <span className="help mt-1 block">{help}</span>}
    </label>
  );
}

export function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  if (!message) return null;
  return (
    <div className="toast" role={message.kind === "error" ? "alert" : "status"}>
      {message.text}
      <button type="button" className="ml-3 underline" onClick={onClose} aria-label="Cerrar aviso">Cerrar</button>
    </div>
  );
}

/** Native <dialog> confirm. Resolves via onConfirm / onCancel. */
export function ConfirmDialog({ open, title, text, confirmLabel = "Borrar", onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onCancel} aria-labelledby="confirm-title">
      <h2 id="confirm-title" className="text-[19px] font-semibold">{title}</h2>
      <p className="mt-2 text-[13px]" style={{ color: "var(--muted)" }}>{text}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

/** Small hook: run an async action and surface errors to the toast. */
export function useAction(notify) {
  const [busy, setBusy] = useState(false);
  const run = async (fn, okText) => {
    setBusy(true);
    try {
      const out = await fn();
      if (okText) notify({ kind: "ok", text: okText });
      return out;
    } catch (error) {
      notify({ kind: "error", text: error.message });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy];
}
