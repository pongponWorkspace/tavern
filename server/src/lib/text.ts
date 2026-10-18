import { invalid } from './errors.js';

export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9฀-๿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'item';
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Validate an external URL (FR-004): only http(s), no credentials, no
 * javascript:/data:/file: or other schemes. Returns display + normalized forms.
 */
export function validateExternalUrl(raw: string, { allowHttp = true } = {}) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid('externalUrl: enter a full URL starting with https://');
  }
  const allowed = allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw invalid(`externalUrl: only ${allowHttp ? 'http and https' : 'https'} links are allowed`);
  }
  if (url.username || url.password) throw invalid('externalUrl: links must not contain credentials');
  if (!url.hostname) throw invalid('externalUrl: link has no host');

  const normalized = new URL(url.toString());
  normalized.hash = '';
  normalized.hostname = normalized.hostname.replace(/^www\./, '');
  let n = `${normalized.hostname}${normalized.port ? `:${normalized.port}` : ''}${normalized.pathname.replace(/\/+$/, '')}${normalized.search}`;
  n = n.toLowerCase();
  return { display: url.toString(), normalized: n };
}

/** Strip path components and unsafe characters from an uploaded filename. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return cleaned || 'file';
}

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}
