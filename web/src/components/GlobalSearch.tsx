import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, type ItemSummary } from '../api';
import { TYPE_LABEL, timeAgo } from '../lib/format';
import { TypeIcon } from './ui';
import { Skel } from './Skeletons';
import { t } from '../lib/i18n';

/** Wrap the matched part of a title in <mark>. */
function highlight(text: string, q: string): ReactNode {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/**
 * Header search across every project the person belongs to. Results appear in
 * a dropdown as you type; ↑/↓ to move, Enter to open, Esc to close. Press "/"
 * or Ctrl/⌘+K anywhere to jump here.
 */
export function GlobalSearch({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const entry = setTimeout(() => setQ(text.trim()), 180);
    return () => clearTimeout(entry);
  }, [text]);
  useEffect(() => setActive(0), [q]);
  // Close after navigating somewhere.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onDown = (e: MouseEvent) => !wrapRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  const res = useQuery({
    queryKey: ['search', tenantId, q],
    queryFn: () => api<{ data: ItemSummary[] }>(`/tenants/${tenantId}/search`, { query: { q, limit: 8 } }),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const results = q ? res.data?.data ?? [] : [];
  const waiting = text.trim() !== q || (res.isFetching && !res.data);

  const go = (item: ItemSummary) => {
    navigate(`/p/${item.projectId}/k/${item.id}`);
    setOpen(false);
    setText('');
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) go(results[active]);
    } else if (e.key === 'Escape') {
      if (open && text) setOpen(false);
      else inputRef.current?.blur();
    }
  };

  const showPop = open && text.trim().length > 0;
  return (
    <div className="gsearch" ref={wrapRef}>
      <div className="search" role="search">
        <Search size={16} />
        <input
          ref={inputRef}
          className="input"
          type="search"
          value={text}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('Search {name}…', { name: tenantName })}
          aria-label={t("Search knowledge across your projects")}
          role="combobox"
          aria-expanded={showPop}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPop && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
        />
        {!text && <span className="kbd kbd-hint" aria-hidden="true">/</span>}
      </div>
      {showPop && (
        <div className="gsearch-pop">
          {waiting && results.length === 0 ? (
            <div role="status" aria-label={t("Searching")}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="gs-item">
                  <Skel w={26} h={26} r={6} />
                  <div className="stack" style={{ gap: 6 }}><Skel w={`${50 + i * 12}%`} h={12} /><Skel w="35%" h={10} /></div>
                </div>
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="gs-empty" role="status">{t("No results for “")}{q}{t("”. Try a different word.")}</div>
          ) : (
            <>
              <div className="gs-head"><span>{t("Knowledge")}</span><span>{results.length === 8 ? t("Top 8") : t(results.length === 1 ? '{n} result' : '{n} results', { n: results.length })}</span></div>
              <ul id={listId} role="listbox" aria-label={t("Search results")}>
                {results.map((r, i) => (
                  <li
                    key={r.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`gs-item ${i === active ? 'active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); go(r); }}
                  >
                    <TypeIcon type={r.type} size="sm" />
                    <div style={{ minWidth: 0 }}>
                      <div className="gs-title ellipsis">{highlight(r.title, q)}</div>
                      <div className="gs-meta ellipsis">
                        {r.project?.name} · {r.category?.name ?? TYPE_LABEL[r.type]}{' '}{t("· updated")}{' '}{timeAgo(r.updatedAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
