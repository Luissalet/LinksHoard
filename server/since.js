// "Since when" as people and assistants say it: an ISO date, an age ("2h", "7d",
// "hace 3 días", "2 weeks ago") or a word ("hoy", "ayer", "esta semana",
// "this month"). Returns an ISO timestamp comparable with saved_at, or null for
// an empty value; anything else throws a 400 that says what is accepted.

const UNIT_MS = {
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, minuto: 60_000, minutos: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, hora: 3_600_000, horas: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000, dia: 86_400_000, dias: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000, semana: 604_800_000, semanas: 604_800_000,
  mo: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000, mes: 2_592_000_000, meses: 2_592_000_000,
  y: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000, ano: 31_536_000_000, anos: 31_536_000_000,
};

export const SINCE_HELP =
  'An ISO date ("2026-09-01"), an age ("2h", "7d", "2w", "hace 3 días", "2 weeks ago") or a word ("hoy", "ayer", "esta semana", "este mes", "today", "yesterday", "this week", "this month").';

function fold(text) {
  return String(text).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function resolveSince(input, nowMs = Date.now()) {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const raw = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    if (raw.length === 10) return raw; // a day compares correctly with full timestamps
    const t = Date.parse(raw.replace(" ", "T"));
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const s = fold(raw);
  const now = new Date(nowMs);
  const words = {
    hoy: () => startOfDay(now), today: () => startOfDay(now),
    ayer: () => new Date(startOfDay(now).getTime() - 86_400_000), yesterday: () => new Date(startOfDay(now).getTime() - 86_400_000),
    "esta semana": () => { const d = startOfDay(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; },
    "this week": () => { const d = startOfDay(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; },
    "este mes": () => { const d = startOfDay(now); d.setDate(1); return d; },
    "this month": () => { const d = startOfDay(now); d.setDate(1); return d; },
    "la semana pasada": () => new Date(nowMs - 7 * 86_400_000), "last week": () => new Date(nowMs - 7 * 86_400_000),
    "el mes pasado": () => new Date(nowMs - 30 * 86_400_000), "last month": () => new Date(nowMs - 30 * 86_400_000),
  };
  if (words[s]) return words[s]().toISOString();
  const m = s.match(/^(?:hace\s+|last\s+)?(\d+(?:[.,]\d+)?)\s*([a-z]+)(?:\s+ago)?$/);
  if (m && UNIT_MS[m[2]]) {
    const n = Number(m[1].replace(",", "."));
    return new Date(nowMs - n * UNIT_MS[m[2]]).toISOString();
  }
  throw Object.assign(new Error(`since: no entiendo "${raw}". ${SINCE_HELP}`), { status: 400 });
}
