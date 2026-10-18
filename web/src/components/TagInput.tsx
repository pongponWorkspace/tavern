import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { t } from '../lib/i18n';

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Tag picker: choose from tags already used in the project, or type a new one.
 * Enter or comma adds; Backspace on an empty field removes the last tag.
 */
export function TagInput({ id, value, onChange, suggestions, max = 20 }: {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: { name: string; itemCount?: number }[];
  max?: number;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const chosen = useMemo(() => new Set(value.map(norm)), [value]);
  const options = useMemo(() => {
    const q = norm(text);
    const matches = suggestions.filter((s) => !chosen.has(norm(s.name)) && (!q || norm(s.name).includes(q)));
    // Prefix matches first, then the rest in their (usage) order.
    matches.sort((a, b) => Number(norm(b.name).startsWith(q)) - Number(norm(a.name).startsWith(q)));
    const list: { name: string; itemCount?: number; isNew?: boolean }[] = matches.slice(0, 8);
    if (q && !chosen.has(q) && !suggestions.some((s) => norm(s.name) === q)) list.push({ name: text.trim(), isNew: true });
    return list;
  }, [text, suggestions, chosen]);

  const add = (name: string) => {
    const entry = name.trim().slice(0, 40);
    if (!entry || chosen.has(norm(entry)) || value.length >= max) return;
    // Reuse the existing spelling when the tag already exists.
    const existing = suggestions.find((s) => norm(s.name) === norm(entry));
    onChange([...value, existing?.name ?? entry]);
    setText('');
    setActive(0);
  };
  const remove = (name: string) => onChange(value.filter((v) => v !== name));

  const showList = open && options.length > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' || e.key === ',') {
      if (e.key === 'Enter' && !text.trim() && !(open && options[active])) return; // let the form submit
      e.preventDefault();
      if (open && options[active] && (e.key === 'Enter' || !text.trim())) add(options[active].name);
      else add(text);
    } else if (e.key === 'Backspace' && !text && value.length) {
      remove(value[value.length - 1]);
    } else if (e.key === 'Escape' && showList) {
      // Close the list, not the surrounding <dialog> (its close request is the keydown default action).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="tag-input-wrap">
      <div className="tag-input" onClick={() => inputRef.current?.focus()}>
        {value.map((entry) => (
          <span key={entry} className="tag">
            {entry}
            <button type="button" className="tag-x" onClick={(e) => { e.stopPropagation(); remove(entry); }} aria-label={t('Remove tag {name}', { name: entry })}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(',')) {
              v.split(',').slice(0, -1).forEach(add);
              setText(v.split(',').pop() ?? '');
            } else setText(v);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Keep a typed-but-unconfirmed tag rather than silently dropping it.
            setTimeout(() => setOpen(false), 120);
            if (text.trim()) add(text);
          }}
          placeholder={value.length ? '' : t("Choose or type a tag")}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          disabled={value.length >= max}
        />
      </div>
      {showList && (
        <ul className="tag-options" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={o.name + (o.isNew ? '-new' : '')}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); add(o.name); }}
              onMouseEnter={() => setActive(i)}
            >
              {o.isNew ? <><Plus size={14} />{' '}{t("Create “")}{o.name}”</> : <><span className="ellipsis">{o.name}</span>{o.itemCount !== undefined && <span className="subtle">{o.itemCount}</span>}</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
