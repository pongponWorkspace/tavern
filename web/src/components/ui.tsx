import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Building2, CheckCircle2, ExternalLink, Eye, FileText, Info, Link2, Paperclip, ShieldCheck, X, XCircle } from 'lucide-react';
import type { ItemType, ProjectRole, TenantRole } from '../api';
import { ApiError } from '../api';
import { colorFor, initials, PROJECT_ROLE_LABEL } from '../lib/format';
import { t, translateError } from '../lib/i18n';

/** The pushpin mark: a pin seen from the side, which reads as a T. Plate and ink follow the theme through tokens. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="10.5" fill="var(--color-accent-emphasis)" />
      <g fill="var(--color-fg-on-emphasis)">
        <rect x="12" y="9" width="24" height="7" rx="3.5" />
        <path d="M18.6 16h10.8l-1.5 9.2h-7.8z" />
        <rect x="13.5" y="24.8" width="21" height="4.6" rx="2.3" />
        <rect x="22.6" y="29" width="2.8" height="11" rx="1.4" />
      </g>
    </svg>
  );
}

export function Spinner({ label = t('Loading') }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner />
    </div>
  );
}

export function Avatar({ id, name, url, size }: { id: string; name: string; url?: string | null; size?: 'sm' | 'lg' }) {
  if (url) return <img className={`avatar ${size ?? ''}`} src={url} alt="" referrerPolicy="no-referrer" />;
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: colorFor(id) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Project roles: Project Admin = accent + shield, Maintainer = teal, Member = neutral, Viewer = outline + eye. */
export function RoleBadge({ role }: { role: ProjectRole }) {
  const tone = { project_admin: 'accent', maintainer: 'teal', member: '', viewer: 'outline' }[role];
  return (
    <span className={`badge ${tone}`}>
      {role === 'project_admin' && <ShieldCheck />}
      {role === 'viewer' && <Eye />}
      {PROJECT_ROLE_LABEL[role]}
    </span>
  );
}

/** Tenant roles: Owner = solid inverse, Admin = neutral; both carry the building icon. */
export function TenantRoleBadge({ role }: { role: TenantRole }) {
  return (
    <span className={`badge ${role === 'owner' ? 'solid' : ''}`}>
      {role !== 'member' && <Building2 />}
      {role === 'owner' ? t("Tenant Owner") : role === 'admin' ? t("Tenant Admin") : t("Member")}
    </span>
  );
}

export function TypeIcon({ type, size }: { type: ItemType; size?: 'sm' }) {
  const s = size === 'sm' ? 14 : 16;
  const Icon = type === 'external_link' ? Link2 : type === 'uploaded_file' ? Paperclip : FileText;
  return (
    <span className={`type-icon ${type} ${size ?? ''}`} aria-hidden="true">
      <Icon size={s} />
    </span>
  );
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children?: ReactNode; title?: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'danger' ? XCircle : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div className="alert-body">
        {title && <span className="alert-title">{title}</span>}
        {children}
      </div>
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = errorText(error);
  return <Alert tone="danger">{msg}</Alert>;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Native <dialog> modal: focus trap, Esc to close and inert background come for free. */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={titleId} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && (
        <>
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open, title, children, confirmLabel, danger, busy, onConfirm, onClose,
}: { open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner /> : confirmLabel}
          </button>
        </>
      }
    >
      <div className="muted">{children}</div>
    </Modal>
  );
}

/** Small dropdown menu; closes on outside click and Escape. */
export function Menu({ trigger, children, align = 'right', up }: { trigger: (p: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div className={`menu ${align === 'right' ? 'right' : ''} ${up ? 'up' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function OpenLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="btn primary" href={href} target="_blank" rel="noopener noreferrer">
      {children ?? t("Open link")} <ExternalLink size={15} />
    </a>
  );
}

// ───────── Toasts ─────────

type Toast = { id: number; text: string; tone: 'default' | 'error' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((entry) => entry.filter((x) => x.id !== id));
  const push = useCallback((text: string, tone: Toast['tone'] = 'default') => {
    const id = Date.now() + Math.random();
    setToasts((entry) => [...entry.slice(-2), { id, text, tone }]);
    // Errors stay until dismissed; confirmations close themselves.
    if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.tone === 'error' ? 'error' : ''}`} role={item.tone === 'error' ? 'alert' : undefined}>
            {item.tone === 'error' ? <XCircle size={16} className="t-icon" /> : <CheckCircle2 size={16} className="t-icon" />}
            <span className="t-text">{item.text}</span>
            <button type="button" className="t-close" onClick={() => dismiss(item.id)} aria-label={t("Dismiss")}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Turn an unknown error into a toast-able sentence. */
export const errorText = (e: unknown) => (e instanceof ApiError ? translateError(e.message) : t('Something went wrong. Please try again.'));
