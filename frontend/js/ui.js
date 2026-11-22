'use strict';
/** Helpers UI. Tout le contenu dynamique passe par textContent (jamais innerHTML) → pas d'XSS. */
const UI = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'required' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function crossIcon(cls = '') {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M9 2h6v7h7v6h-7v7H9v-7H2V9h7z');
    s.append(p); return s;
  }

  function toast(msg, isErr = false) {
    const t = h('div', { class: `toast${isErr ? ' err' : ''}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), isErr ? 6000 : 3500);
  }

  /** Modale accessible : Échap ferme, focus rendu à l'élément précédent. */
  function modal(title, body, { wide = false } = {}) {
    const prev = document.activeElement;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title), body);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
    document.body.append(overlay); document.addEventListener('keydown', onKey);
    const first = box.querySelector('input,select,button'); first && first.focus();
    return { close, box };
  }

  const field = (label, input, hint) => {
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint && h('span', { class: 'hint' }, hint));
  };

  /* ---- Fuseau horaire de la pharmacie (nom IANA, fourni par /api/auth/me) ----
     Les instants (timestamps) s'affichent et se saisissent dans ce fuseau, jamais dans celui de l'appareil.
     Les dates seules (AAAA-MM-JJ : péremption, naissance…) n'ont pas de fuseau : elles ne sont jamais décalées. */
  let TZ = 'UTC';
  const validTz = (tz) => { try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return true; } catch { return false; } };
  const setTimezone = (tz) => { TZ = typeof tz === 'string' && validTz(tz) ? tz : 'UTC'; };
  const getTimezone = () => TZ;
  const fmts = new Map();
  const partsOf = (ms, tz) => {
    let f = fmts.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmts.set(tz, f); }
    const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value; return o;
  };
  /** Jour AAAA-MM-JJ, dans le fuseau de la pharmacie, d'un instant (maintenant par défaut). */
  const today = (d = new Date()) => { const p = partsOf(+d, TZ); return `${p.year}-${p.month}-${p.day}`; };
  /** Valeur d'un champ datetime-local (AAAA-MM-JJTHH:MM) pour un instant ISO, à l'heure de la pharmacie. */
  const toInputValue = (iso) => { if (!iso) return ''; const p = partsOf(Date.parse(iso), TZ); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  /** Instant ISO (UTC) correspondant à une heure saisie « murale » AAAA-MM-JJTHH:MM dans le fuseau de la pharmacie. */
  const fromInputValue = (local) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || ''); if (!m) return new Date(NaN).toISOString();
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const off = (ms) => { const p = partsOf(ms, TZ); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
    let t = wall - off(wall); t = wall - off(t);
    return new Date(t).toISOString();
  };
  const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const fmtDate = (d) => {
    if (!d) return '—';
    const s = String(d);
    return DAY_ONLY.test(s.slice(0, 10)) && (s.length === 10 || !s.includes('T'))
      ? new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' })
      : new Date(d).toLocaleDateString('fr-FR', { timeZone: TZ });
  };
  const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }) : '—');
  const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
  const fmtDay = (d) => (d ? String(d).slice(0, 10) : '');

  /** Affiche un mot de passe temporaire une seule fois. */
  function showTempPassword(who, pwd, afterClose) {
    const body = h('div', {},
      h('p', {}, `Mot de passe temporaire pour ${who}. Il ne sera plus affiché : transmettez-le de façon sécurisée. Un changement est exigé à la première connexion.`),
      h('div', { class: 'secret' }, pwd),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(pwd).then(() => toast('Copié')) }, 'Copier'),
        h('button', { class: 'btn primary', onclick: () => { m.close(); afterClose && afterClose(); } }, 'J’ai noté le mot de passe')));
    const m = modal('Accès créé', body);
  }

  return { h, crossIcon, toast, modal, field, fmtDate, fmtDateTime, fmtTime, fmtDay, showTempPassword, setTimezone, getTimezone, today, toInputValue, fromInputValue };
})();
