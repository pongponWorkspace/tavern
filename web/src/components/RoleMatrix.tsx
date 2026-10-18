import { Fragment, type ReactNode } from 'react';
import { Check, Lock, Minus } from 'lucide-react';
import { t } from '../lib/i18n';

export interface MatrixColumn {
  key: string;
  /** Plain role name, used for accessible cell labels. */
  label: string;
  header: ReactNode;
  /** Always holds every capability (Owner / Project Admin). */
  full?: boolean;
}

export interface MatrixRow {
  key: string;
  label: string;
  hint?: string;
  group: string;
  kind?: 'bool' | 'scope';
  /** Same value for every role and not editable (e.g. everyone can view). */
  everyone?: string;
  /** Only the full-access column has it; reason shown on the lock. */
  fullOnly?: string;
  /** Per-column locks: column key → reason. Locked cells read as "no". */
  lockedFor?: Record<string, string>;
}

type Value = boolean | 'none' | 'own' | 'all';

const SCOPE_LABEL = { get none() { return t('None'); }, get own() { return t('Own items'); }, get all() { return t('All items'); } };

function Yes({ title }: { title?: string }) {
  return <span className="rm-yes" title={title} aria-label={title ?? t("Allowed")}><Check size={15} /></span>;
}
function Locked({ reason, on }: { reason: string; on?: boolean }) {
  return (
    <span className={`rm-locked ${on ? 'on' : ''}`} title={reason} aria-label={`${on ? t('Always allowed') : t('Not available')}: ${reason}`}>
      {on ? <Check size={14} /> : <Minus size={14} />}
      <Lock size={11} />
    </span>
  );
}

/**
 * Role × capability table. Columns are roles, rows are capabilities grouped
 * by area. Editable cells are checkboxes (or a scope select); locked cells
 * explain why on hover/focus.
 */
export function RoleMatrix({ columns, rows, value, onChange, readOnly, caption, highlight }: {
  /** Column key to mark as "You" (the viewer's own role). */
  highlight?: string;
  columns: MatrixColumn[];
  rows: MatrixRow[];
  value: Record<string, Record<string, Value>>;
  onChange?: (column: string, row: string, next: Value) => void;
  readOnly?: boolean;
  caption: string;
}) {
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="card table-wrap">
      <table className="table rm">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t("Capability")}</th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`rm-col ${c.key === highlight ? 'rm-you' : ''}`}>
                {c.header}
                {c.key === highlight && <span className="rm-you-label">{t("You")}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g}>
              <tr className="rm-group"><th colSpan={columns.length + 1} scope="colgroup">{g}</th></tr>
              {rows.filter((r) => r.group === g).map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="rm-label">
                    <span>{r.label}</span>
                    {r.hint && <span className="rm-hint">{r.hint}</span>}
                  </th>
                  {columns.map((c) => {
                    let cell: ReactNode;
                    if (r.everyone) cell = <Locked on reason={r.everyone} />;
                    else if (c.full) cell = r.kind === 'scope' ? <span className="rm-scope-fixed">{SCOPE_LABEL.all}</span> : <Yes title={t("Always allowed")} />;
                    else if (r.fullOnly) cell = <Locked reason={r.fullOnly} />;
                    else if (r.lockedFor?.[c.key]) cell = <Locked reason={r.lockedFor[c.key]} />;
                    else {
                      const v = value[c.key]?.[r.key];
                      const name = `${r.label} — ${c.label}`;
                      if (r.kind === 'scope') {
                        cell = readOnly ? (
                          <span className={`rm-scope ${v === 'none' ? 'off' : ''}`}>{SCOPE_LABEL[(v as keyof typeof SCOPE_LABEL) ?? 'none']}</span>
                        ) : (
                          <select className="select rm-select" value={v as string} aria-label={name} onChange={(e) => onChange?.(c.key, r.key, e.target.value as Value)}>
                            {(['none', 'own', 'all'] as const).map((o) => <option key={o} value={o}>{SCOPE_LABEL[o]}</option>)}
                          </select>
                        );
                      } else {
                        cell = readOnly ? (
                          v ? <Yes /> : <span className="rm-no" aria-label={t("Not allowed")}><Minus size={14} /></span>
                        ) : (
                          <input type="checkbox" className="rm-check" checked={Boolean(v)} aria-label={name} onChange={(e) => onChange?.(c.key, r.key, e.target.checked)} />
                        );
                      }
                    }
                    return <td key={c.key} className={`rm-cell ${c.key === highlight ? 'rm-you' : ''}`}>{cell}</td>;
                  })}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
