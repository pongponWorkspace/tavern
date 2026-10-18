import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api } from '../api';
import { Empty, ErrorAlert, PageLoading } from '../components/ui';
import { FormSkeleton, PageHeadSkeleton } from '../components/Skeletons';
import { fullDate } from '../lib/format';

/** Development email sink — shows what would have been emailed. */
export function DevMailbox() {
  const q = useQuery({ queryKey: ['mailbox'], queryFn: () => api('/dev/mailbox'), refetchInterval: 4000 });
  if (q.isLoading) return <div className="content narrow"><PageHeadSkeleton /><FormSkeleton fields={2} /></div>;
  const linkify = (body: string) =>
    body.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part}>{part}</a> : part));
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Dev mailbox</h1>
          <p className="lede">Development only.</p>
        </div>
      </div>
      <ErrorAlert error={q.error} />
      {q.data?.data.length === 0 && <div className="card"><Empty icon={<Inbox size={22} />} title="No emails yet" /></div>}
      <div className="stack">
        {q.data?.data.map((m: any) => (
          <article key={m.id} className="card card-pad stack" style={{ gap: 8 }}>
            <div className="row wrap"><strong>{m.subject}</strong><span className="spacer" /><span className="subtle">{fullDate(m.createdAt)}</span></div>
            <div className="subtle">To: {m.to}</div>
            <div className="mail">{linkify(m.body)}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
