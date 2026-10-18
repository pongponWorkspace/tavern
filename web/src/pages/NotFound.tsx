import { Link, Navigate } from 'react-router';
import { Compass } from 'lucide-react';
import { Empty } from '../components/ui';
import { t } from '../lib/i18n';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="content">
      <Empty icon={<Compass size={22} />} title={t(`We couldn't find that ${what}`)} action={<Link to="/" className="btn">{t("Go home")}</Link>}>{t("It may have been moved or archived, or you may not have access to it.")}</Empty>
    </div>
  );
}

/**
 * An organization link that isn't one of yours (old bookmark, removed access, or a
 * database reset) goes to your own organization instead of a dead end. The same thing
 * happens whether or not the organization exists, so nothing is revealed.
 */
export function UnknownOrganization() {
  try {
    localStorage.removeItem('tavern.lastTenant');
  } catch {
    /* storage unavailable — fine */
  }
  return <Navigate to="/" replace />;
}
