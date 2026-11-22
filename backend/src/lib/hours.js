'use strict';
/** Heures travaillées : somme des pointages fermés, arrondie à la minute. */
const entryMinutes = (inIso, outIso) => Math.max(0, Math.round((Date.parse(outIso) - Date.parse(inIso)) / 60000));
/** entries : [{ userId, clockIn, clockOut|null }] → [{ userId, minutes, hours, openEntries }] */
function summarize(entries) {
  const by = new Map();
  for (const e of entries) {
    const u = by.get(e.userId) || { userId: e.userId, minutes: 0, openEntries: 0 };
    if (e.clockOut) u.minutes += entryMinutes(e.clockIn, e.clockOut); else u.openEntries++;
    by.set(e.userId, u);
  }
  return [...by.values()].map((u) => ({ ...u, hours: Math.round((u.minutes / 60) * 100) / 100 }));
}
module.exports = { entryMinutes, summarize };
