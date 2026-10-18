import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

// Links in user content open in a new tab without access to this window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:|#|\/)/i.test(href)) node.removeAttribute('href');
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/** Render untrusted Markdown: parse, then sanitize before it ever reaches the DOM (NFR-001). */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source || '', { async: false }) as string, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'textarea', 'select'],
        ADD_TAGS: [],
        ALLOW_DATA_ATTR: false,
      }),
    [source],
  );
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
