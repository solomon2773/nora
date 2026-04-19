export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatShortId(value, length = 8) {
  if (!value) return "—";
  return String(value).slice(0, length);
}

export function formatCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return numeric.toLocaleString();
}

export function formatPercent(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(digits)}%`;
}

export function formatMemoryMb(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(numeric >= 100 ? 0 : 1)} MB`;
}

export function formatRateMb(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(numeric >= 10 ? 1 : 2)} MB/s`;
}

export function formatDurationSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "—";

  if (numeric < 60) return `${Math.round(numeric)}s`;
  if (numeric < 3600) return `${Math.floor(numeric / 60)}m`;

  const hours = Math.floor(numeric / 3600);
  const minutes = Math.floor((numeric % 3600) / 60);
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
