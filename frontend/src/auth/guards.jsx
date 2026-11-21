import { Navigate, Outlet, useLocation } from 'react-router';

import { Splash, Forbidden } from '../components/ui.jsx';
import { useAuth } from './AuthContext.jsx';

/** Only signed-in users get past this; others go to the sign-in page and come back after. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status !== 'signed-in') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Only the listed roles see the nested routes. The API enforces the same rule. */
export function RequireRole({ roles }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) return <Forbidden />;
  return <Outlet />;
}

/** A redirect target is used only if it is a path inside this app. */
export function safeReturnPath(from) {
  if (typeof from !== 'string') return '/';
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\') || from.startsWith('/sign-in')) return '/';
  return from;
}
