// Loading placeholders shaped like the real layouts, so content lands where the
// eye is already looking. Each block pulses (opacity only); screen readers get
// a single "Loading" status per placeholder region.

import type { CSSProperties, ReactNode } from 'react';
import { BrandMark } from './ui';

export function Skel({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />;
}

function Region({ label = 'Loading', children, style }: { label?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" style={style}>
      {children}
    </div>
  );
}

/** Full-window splash while the session is resolved. Matches the static one in index.html. */
export function AppSplash() {
  return (
    <div className="boot" role="status" aria-label="Loading Tavern">
      <BrandMark size={40} />
      <div className="boot-bar"><span /></div>
    </div>
  );
}

export function PageHeadSkeleton({ crumbs, lede = true, action }: { crumbs?: boolean; lede?: boolean; action?: boolean }) {
  return (
    <div className="page-head">
      <div className="stack" style={{ gap: 10, flex: 1 }}>
        {crumbs && <Skel w={180} h={10} />}
        <Skel w={260} h={24} />
        {lede && <Skel w="min(420px, 80%)" h={12} />}
      </div>
      {action && <Skel w={130} h={32} r={6} />}
    </div>
  );
}

export function TabsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="tabs" aria-hidden="true" style={{ gap: 20, paddingBottom: 12 }}>
      {Array.from({ length: n }, (_, i) => <Skel key={i} w={[72, 86, 96, 74, 70, 68][i % 6]} h={14} />)}
    </div>
  );
}

/** Card with an icon, a title and two text lines — dashboard projects, pinned items, workspaces. */
export function TileSkeleton() {
  return (
    <div className="card k-tile">
      <div className="row"><Skel w={28} h={28} r={6} /><span className="spacer" /><Skel w={70} h={18} r={999} /></div>
      <div className="stack" style={{ gap: 8 }}>
        <Skel w="60%" h={15} />
        <Skel w="90%" h={11} />
        <Skel w="70%" h={11} />
      </div>
      <div className="k-tile-foot"><Skel w={80} h={10} /><span className="spacer" /><Skel w={60} h={10} /></div>
    </div>
  );
}

export function TileGridSkeleton({ n = 3 }: { n?: number }) {
  return (
    <Region label="Loading cards">
      <div className="grid-3">{Array.from({ length: n }, (_, i) => <TileSkeleton key={i} />)}</div>
    </Region>
  );
}

export function TableSkeleton({ rows = 5, cols = 4, avatar = true }: { rows?: number; cols?: number; avatar?: boolean }) {
  const widths = ['70%', '50%', '40%', '55%', '35%'];
  return (
    <Region label="Loading table">
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>{Array.from({ length: cols }, (_, c) => <th key={c}><Skel w={c === 0 ? 80 : 56} h={10} /></th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>
                    {c === 0 && avatar ? (
                      <div className="person">
                        <Skel w={28} h={28} r={999} />
                        <div className="stack" style={{ gap: 6, flex: 1 }}><Skel w={120 + ((r * 37) % 60)} h={12} /><Skel w={150} h={10} /></div>
                      </div>
                    ) : (
                      <Skel w={widths[(r + c) % widths.length]} h={12} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Region>
  );
}

export function ChecklistSkeleton({ steps = 4 }: { steps?: number }) {
  return (
    <Region label="Loading checklist">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-pad stack" style={{ gap: 10 }}><Skel w={220} h={14} /><Skel h={6} r={999} /></div>
      </div>
      <div className="card">
        <div className="card-head"><div className="stack" style={{ gap: 8 }}><Skel w={160} h={14} /><Skel w={240} h={10} /></div></div>
        {Array.from({ length: steps }, (_, i) => (
          <div key={i} className="check-item">
            <Skel w={24} h={24} r={999} />
            <div className="stack" style={{ gap: 8 }}>
              <Skel w={`${45 + ((i * 13) % 30)}%`} h={13} />
              <Skel w="70%" h={11} />
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}

/** Two-column knowledge item page: header, actions, body, metadata panel. */
export function DetailSkeleton() {
  return (
    <Region label="Loading item">
      <Skel w={100} h={12} style={{ marginBottom: 20 }} />
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px', alignItems: 'start', gap: 28 }}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
            <Skel w={34} h={34} r={8} />
            <div className="stack" style={{ gap: 10, flex: 1 }}><Skel w="55%" h={22} /><Skel w={160} h={18} r={999} /></div>
          </div>
          <Skel w="80%" h={13} />
          <div className="row" style={{ gap: 8 }}><Skel w={120} h={32} r={6} /><Skel w={110} h={32} r={6} /><Skel w={80} h={32} r={6} /></div>
          <DocSkeleton />
        </div>
        <div className="card card-pad stack" style={{ gap: 18 }}>
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="stack" style={{ gap: 6 }}><Skel w={70} h={9} /><Skel w={`${50 + i * 9}%`} h={12} /></div>)}
        </div>
      </div>
    </Region>
  );
}

export function DocSkeleton() {
  return (
    <div className="card card-pad stack" style={{ gap: 12, marginTop: 14, padding: '24px 28px' }} aria-hidden="true">
      <Skel w="45%" h={20} />
      {['96%', '92%', '88%', '60%'].map((w, i) => <Skel key={i} w={w} h={12} />)}
      <Skel w="30%" h={16} style={{ marginTop: 8 }} />
      {['94%', '82%', '70%'].map((w, i) => <Skel key={i} w={w} h={12} />)}
    </div>
  );
}

export function FormSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <Region label="Loading form">
      <div className="card card-pad stack" style={{ gap: 18 }}>
        <Skel w={160} h={16} />
        {Array.from({ length: fields }, (_, i) => <div key={i} className="stack" style={{ gap: 8 }}><Skel w={90} h={11} /><Skel h={32} r={6} /></div>)}
        <div className="row"><span className="spacer" /><Skel w={110} h={32} r={6} /></div>
      </div>
    </Region>
  );
}

/** Project shell: crumbs, title, role label, tabs, then an overview-shaped body. */
export function ProjectSkeleton() {
  return (
    <div className="content">
      <Region label="Loading project">
        <div className="page-head" style={{ marginBottom: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            <Skel w={170} h={10} />
            <div className="row" style={{ gap: 12 }}><Skel w={240} h={24} /><Skel w={96} h={20} r={999} /></div>
          </div>
        </div>
        <TabsSkeleton n={6} />
        <div className="stack" style={{ gap: 8, marginBottom: 32 }}><Skel w="70%" h={14} /><Skel w="45%" h={14} /></div>
        <Skel w={90} h={16} style={{ marginBottom: 12 }} />
        <div className="grid-3">{[0, 1, 2].map((i) => <TileSkeleton key={i} />)}</div>
      </Region>
    </div>
  );
}

export function NavSkeleton({ n = 3 }: { n?: number }) {
  return (
    <div aria-hidden="true" className="stack" style={{ gap: 12, padding: '10px 8px' }}>
      {Array.from({ length: n }, (_, i) => <div key={i} className="row" style={{ gap: 10 }}><Skel w={16} h={16} r={4} /><Skel w={`${55 + ((i * 17) % 30)}%`} h={11} /></div>)}
    </div>
  );
}
