// Two-language UI (English / Thai). The English text is the key: t('Sign in')
// returns the Thai string when Thai is on, and the English text when no
// translation exists, so nothing ever renders blank.
//
// Switching language remounts the app tree (key={lang}), so plain module
// functions like t() and the date formatters always use the current language
// without every component subscribing to a context.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { TH } from './th';

export type Lang = 'en' | 'th';
export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'th', label: 'ไทย' },
];

const STORAGE_KEY = 'tavern.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'th') return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('th') ? 'th' : 'en';
}

let current: Lang = initialLang();
export const lang = () => current;
/** Locale for Intl formatters. Thai uses the Buddhist calendar, as Thai readers expect. */
export const locale = () => (current === 'th' ? 'th-TH' : 'en-GB');

/** Translate, with {name} placeholders filled from vars. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = current === 'th' ? TH[text] ?? text : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

// Server messages that carry a value; everything else is looked up as-is.
const ERROR_PATTERNS: [RegExp, string][] = [
  [/^The requested (.+) was not found\.$/, 'The requested {what} was not found.'],
  [/^This invitation is limited to @(.+) addresses\.$/, 'This invitation is limited to @{what} addresses.'],
  [/^This person is the only Project Admin of: (.+)\. Assign another admin first\.$/, 'This person is the only Project Admin of: {what}. Assign another admin first.'],
];

/** Translate an error message from the API. */
export function translateError(message: string): string {
  if (current !== 'th') return message;
  if (TH[message]) return TH[message];
  for (const [re, key] of ERROR_PATTERNS) {
    const m = message.match(re);
    if (m) return t(key, { what: TH[m[1]!] ?? m[1]! });
  }
  return message;
}

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang: () => {} });
export const useLang = () => useContext(Ctx);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Lang>(current);
  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable — still switches for this visit */
    }
    setValue(l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = value;
  }, [value]);
  return (
    <Ctx.Provider value={{ lang: value, setLang }}>
      <div key={value} style={{ display: 'contents' }}>{children}</div>
    </Ctx.Provider>
  );
}

/** Small EN | ไทย switch. */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { lang: l, setLang } = useLang();
  return (
    <div className={`seg lang-switch ${className}`} role="group" aria-label="Language / ภาษา">
      {LANGS.map((x) => (
        <button key={x.code} type="button" className={l === x.code ? 'on' : ''} aria-pressed={l === x.code} onClick={() => setLang(x.code)} lang={x.code}>
          {x.code === 'en' ? 'EN' : 'ไทย'}
        </button>
      ))}
    </div>
  );
}
