// Role labels and the permission rules the screens need. These only decide
// what to show; the API enforces every rule again and logs refusals.

export const ROLE_LABELS = {
  administrator: 'Administrator',
  investigator: 'Investigator',
  custodian: 'Evidence custodian',
  auditor: 'Auditor',
};

export const canCreateCase = (user) => user.role === 'administrator' || user.role === 'investigator';

/** Administrators manage any case; investigators only the cases they opened. */
export const canManageCase = (user, c) =>
  user.role === 'administrator' || (user.role === 'investigator' && c.createdBy === user.id);

export const canReopenCase = (user) => user.role === 'administrator';

export const seesAlerts = (user) => user.role === 'administrator' || user.role === 'auditor';

/**
 * Navigation, filtered by role. `phase` marks screens that are planned but
 * not built yet; they open a placeholder page.
 */
export const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/cases', label: 'Cases' },
  { to: '/evidence', label: 'Evidence', phase: 5 },
  { to: '/audit', label: 'Audit log', roles: ['administrator', 'auditor'], phase: 5 },
  { to: '/users', label: 'Users', roles: ['administrator'], phase: 5 },
];

export const navFor = (user) => NAV.filter((item) => !item.roles || item.roles.includes(user.role));
