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

/** Registering: administrators anywhere; investigators on assigned cases (the API checks assignment). */
export const canRegisterEvidence = (user) => user.role === 'administrator' || user.role === 'investigator';

/** Auditors may inspect everything but never download the original file. */
export const canDownload = (user) => user.role !== 'auditor';

/** The holder may request a transfer; administrators may reassign any item. */
export const canRequestTransfer = (user, evidence) =>
  user.role !== 'auditor' && (evidence.currentCustodianId === user.id || user.role === 'administrator');

/** Roles that can hold evidence (transfer recipients). */
export const HOLDER_ROLES = ['administrator', 'investigator', 'custodian'];

/** Navigation, filtered by role. */
export const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/cases', label: 'Cases' },
  { to: '/evidence', label: 'Evidence' },
  { to: '/audit', label: 'Audit log', roles: ['administrator', 'auditor'] },
  { to: '/alerts', label: 'Alerts', roles: ['administrator', 'auditor'] },
  { to: '/users', label: 'Users', roles: ['administrator'] },
];

export const navFor = (user) => NAV.filter((item) => !item.roles || item.roles.includes(user.role));
