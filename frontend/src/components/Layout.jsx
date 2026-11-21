import { NavLink, Outlet } from 'react-router';

import { useAuth } from '../auth/AuthContext.jsx';
import { navFor } from '../roles.js';
import { RoleBadge } from './ui.jsx';

export default function Layout() {
  const { user, signOut } = useAuth();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">
            <strong>EvidenceVault</strong>
            <span>Rwanda</span>
          </span>
        </div>

        <nav className="nav" aria-label="Main">
          {navFor(user).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
              <span>{item.label}</span>
              {item.phase && (
                <span className="nav-soon" title={`Screen built in Phase ${item.phase}`}>
                  P{item.phase}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="whoami">
          <p className="whoami-name">{user.fullName}</p>
          <p className="whoami-email">{user.email}</p>
          <RoleBadge role={user.role} />
          <button type="button" className="btn btn-ghost-dark" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
