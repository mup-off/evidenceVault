// Dates are shown in Kigali time (CAT, UTC+2) whatever the laptop's time
// zone, so every screen and printout gives the same time for the same event.

const TIME_ZONE = 'Africa/Kigali';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' });
const longDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export const formatDateTime = (iso) => (iso ? `${dateTime.format(new Date(iso))} CAT` : '—');
export const formatDate = (iso) => (iso ? dateOnly.format(new Date(iso)) : '—');
export const formatLongDate = (d = new Date()) => longDate.format(d);

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** First word of a full name, for greetings. */
export const firstName = (fullName = '') => fullName.trim().split(/\s+/)[0] || fullName;
