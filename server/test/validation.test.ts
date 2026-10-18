// Unit tests for URL / filename validation (lib/text.ts) and the built-in
// content scanner (files.ts sniff + scanBuffer).
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { extensionOf, safeFilename, validateExternalUrl } from '../src/lib/text.js';
import { scanBuffer, sniff } from '../src/modules/files.js';

// Assembled at runtime so the source file itself is not flagged by local antivirus.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const MZ = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), Buffer.alloc(64, 0)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(32, 0)]);

function rejects(raw: string, opts?: { allowHttp?: boolean }) {
  try {
    validateExternalUrl(raw, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(422);
    expect((e as AppError).code).toBe('VALIDATION_ERROR');
    return;
  }
  throw new Error(`expected ${raw} to be rejected`);
}

describe('validateExternalUrl', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(document.cookie)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'vbscript:msgbox(1)',
    'mailto:someone@example.com',
    'not a url',
    '//example.com/protocol-relative',
    '/relative/path',
    '',
  ])('rejects %s', (raw) => rejects(raw));

  it.each(['https://user:pass@example.com/', 'https://user@example.com/', 'http://:secret@example.com/'])(
    'rejects embedded credentials %s',
    (raw) => rejects(raw),
  );

  it('rejects http when allowHttp is false', () => {
    rejects('http://example.com', { allowHttp: false });
    expect(validateExternalUrl('https://example.com', { allowHttp: false }).normalized).toBe('example.com');
  });

  it('accepts http and https', () => {
    expect(validateExternalUrl('http://example.com/a').display).toBe('http://example.com/a');
    expect(validateExternalUrl('https://example.com/a').display).toBe('https://example.com/a');
  });

  it('normalizes host case, www., trailing slash and fragment; keeps the display URL', () => {
    const v = validateExternalUrl('  https://WWW.Example.COM/Docs/Guide/?q=1#section  ');
    expect(v.display).toBe('https://www.example.com/Docs/Guide/?q=1#section');
    expect(v.normalized).toBe('example.com/docs/guide?q=1');
  });

  it('normalizes equivalent URLs to the same key (duplicate detection)', () => {
    const a = validateExternalUrl('https://www.example.com/path/').normalized;
    const b = validateExternalUrl('http://example.com/path#x').normalized;
    expect(a).toBe(b);
  });

  it('keeps non-default ports in the normalized form', () => {
    expect(validateExternalUrl('https://example.com:8443/x').normalized).toBe('example.com:8443/x');
  });
});

describe('safeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\evil.pdf', 'evil.pdf'],
    ['/absolute/path/report.pdf', 'report.pdf'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['.htaccess', 'htaccess'],
    ['...hidden.txt', 'hidden.txt'],
    ['a<b>:c|d?e*f".pdf', 'abcdef.pdf'],
    ['nul\u0000byte.pdf', 'nulbyte.pdf'],
    ['line\nbreak.txt', 'linebreak.txt'],
    ['', 'file'],
    ['..', 'file'],
    ['../', 'file'],
    ['   ', 'file'],
  ])('%j → %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it('never returns a path separator or a leading dot', () => {
    for (const name of ['../../../x', '..\\..\\x', 'a/b/c/..', '....//....//x.pdf', '.\\.\\.env']) {
      const out = safeFilename(name);
      expect(out).not.toMatch(/[\\/]/);
      expect(out.startsWith('.')).toBe(false);
    }
  });

  it('caps length at 150 characters', () => {
    expect(safeFilename('a'.repeat(300) + '.pdf').length).toBe(150);
  });

  it('extensionOf reads only the final extension', () => {
    expect(extensionOf('report.final.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('evil.pdf.exe')).toBe('exe');
  });
});

describe('sniff', () => {
  it('detects real types from leading bytes', () => {
    expect(sniff(PDF)).toBe('application/pdf');
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniff(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniff(MZ)).toBe('application/x-executable');
    expect(sniff(ELF)).toBe('application/x-executable');
    expect(sniff(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBe('application/x-executable');
    expect(sniff(Buffer.from('# Heading\n\nSome *markdown* text. ภาษาไทย\n'))).toBe('text/plain');
    expect(sniff(Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]))).toBe('application/octet-stream');
  });
});

describe('scanBuffer', () => {
  it('quarantines the EICAR test signature, whatever the extension', () => {
    for (const name of ['virus.txt', 'notes.md', 'data.csv']) {
      const r = scanBuffer(Buffer.from(EICAR, 'latin1'), name);
      expect(r.status).toBe('quarantined');
      expect(r.detail).toMatch(/Malware/);
    }
    // Embedded inside otherwise valid content too.
    expect(scanBuffer(Buffer.concat([PDF, Buffer.from(EICAR, 'latin1')]), 'doc.pdf').status).toBe('quarantined');
  });

  it('quarantines MZ / ELF / shebang executables even with a document extension', () => {
    expect(scanBuffer(MZ, 'invoice.pdf')).toMatchObject({ status: 'quarantined', mimeType: 'application/x-executable' });
    expect(scanBuffer(ELF, 'photo.png').status).toBe('quarantined');
    expect(scanBuffer(Buffer.from('#!/bin/bash\necho hi\n'), 'readme.txt').status).toBe('quarantined');
  });

  it('quarantines content that does not match the extension (PNG bytes named .pdf)', () => {
    const r = scanBuffer(PNG, 'report.pdf');
    expect(r.status).toBe('quarantined');
    expect(r.mimeType).toBe('image/png');
    expect(r.detail).toMatch(/\.pdf/);
  });

  it('quarantines binary content named .txt and anything with a non-allowed extension', () => {
    expect(scanBuffer(PNG, 'notes.txt').status).toBe('quarantined');
    expect(scanBuffer(Buffer.from('hello'), 'page.html').status).toBe('quarantined');
    expect(scanBuffer(Buffer.from('<svg/>'), 'img.svg').status).toBe('quarantined');
  });

  it('marks a valid PDF clean with its sniffed type', () => {
    expect(scanBuffer(PDF, 'report.pdf')).toEqual({ status: 'clean', mimeType: 'application/pdf', detail: null });
  });

  it('marks valid images clean', () => {
    expect(scanBuffer(PNG, 'pic.png')).toEqual({ status: 'clean', mimeType: 'image/png', detail: null });
  });

  // BUG (src/modules/files.ts sniff, TextDecoder line): for text longer than 8 KB the
  // 8192-byte sample is cut 4 bytes short with no regard for UTF-8 boundaries, so a
  // multi-byte character (e.g. Thai, 3 bytes) straddling the cut makes the fatal
  // decoder throw → 'application/octet-stream' → a legitimate document is quarantined.
  it('a long UTF-8 (Thai) markdown file is clean', () => {
    const thai = Buffer.from('สวัสดีครับ'.repeat(400)); // 12,000 bytes, valid UTF-8
    expect(sniff(thai)).toBe('text/plain');
    expect(scanBuffer(thai, 'notes.md').status).toBe('clean');
  });

  it('a long ASCII markdown file is clean (control for the bug above)', () => {
    const ascii = Buffer.from('# Notes\n' + 'hello world\n'.repeat(2000));
    expect(scanBuffer(ascii, 'notes.md').status).toBe('clean');
  });

  it('marks a text .md file clean, typed by the extension', () => {
    expect(scanBuffer(Buffer.from('# Title\n\nBody text\n'), 'README.md')).toEqual({ status: 'clean', mimeType: 'text/markdown', detail: null });
    expect(scanBuffer(Buffer.from('a,b\n1,2\n'), 'data.csv')).toEqual({ status: 'clean', mimeType: 'text/csv', detail: null });
    expect(scanBuffer(Buffer.from('plain'), 'notes.txt')).toEqual({ status: 'clean', mimeType: 'text/plain', detail: null });
  });
});
