'use strict';
/** Plannings : créneaux en minutes depuis une origine commune (indépendant du fuseau). Fin ≤ début ⇒ le créneau finit le lendemain. */
const dayIndex = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
const minutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
function span(date, start, end) {
  const s = dayIndex(date) * 1440 + minutes(start); let e = dayIndex(date) * 1440 + minutes(end);
  if (e <= s) e += 1440;
  return { start: s, end: e };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
/** Premier créneau existant qui chevauche le nouveau (même personne), sinon undefined. */
const findOverlap = (candidate, existing) => existing.find((x) => overlaps(span(candidate.date, candidate.start, candidate.end), span(x.shift_date, x.start_time, x.end_time)));
/** Absence couvrant la date du créneau. */
const absenceOn = (date, absences) => absences.find((a) => a.start_date <= date && date <= a.end_date);
const shiftMinutes = (date, start, end) => { const s = span(date, start, end); return s.end - s.start; };
module.exports = { span, overlaps, findOverlap, absenceOn, shiftMinutes, minutes };
