import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Empty } from '../components/ui';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="content">
      <Empty icon={<Compass size={22} />} title={`We couldn't find that ${what}`} action={<Link to="/" className="btn">Go home</Link>}>
        It may have been moved or archived, or you may not have access to it.
      </Empty>
    </div>
  );
}
