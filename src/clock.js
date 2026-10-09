// Demo clock. All app code asks for time through here, so a UI control can push
// the clock forward (to watch a Tier 2 request escalate live) without touching
// system time. The offset is persisted in the settings table so it survives
// restarts.

const KEY = 'clock_offset_ms';

export function getClockOffsetMs(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? Number(row.value) : 0;
}

export function setClockOffsetMs(db, ms) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(KEY, String(Math.round(ms)));
}

export function nowMs(db) {
  return Date.now() + getClockOffsetMs(db);
}

export function now(db) {
  return new Date(nowMs(db));
}

export const HOUR = 3600e3;
export const DAY = 86400e3;
