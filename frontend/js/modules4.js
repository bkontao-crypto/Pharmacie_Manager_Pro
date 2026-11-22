'use strict';
/** Vues Phase 5 : CRM & Fidélité, RH & Planning. */
(() => {
  const { h, toast, modal, field, fmtDate, fmtDateTime } = UI;
  const { can, money, debounce, qs, toastErr, kv, closeBtn } = ModuleKit;
  const iso = (d) => UI.today(d);                                   // jour de la pharmacie, d'un instant
  const isoUTC = (d) => d.toISOString().slice(0, 10);               // arithmétique sur des dates seules (sans fuseau)
  const addDays = (s, n) => isoUTC(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));
  const mondayOf = (s) => { const d = new Date(`${s}T00:00:00Z`); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
  const seg = (items, current, onPick) => h('div', { class: 'seg', role: 'group' }, items.map(([k, l]) => h('button', { class: `btn sm${k === current ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(k === current), onclick: () => onPick(k) }, l)));
  const tabbed = (content, title, tabsDef, first, actions) => { let tab = first; const holder = h('div'); const tabs = h('div', { class: 'toolbar' });
    const show = async () => { tabs.replaceChildren(seg(tabsDef.map(([k, l]) => [k, l]), tab, (k) => { tab = k; show(); })); holder.replaceChildren(); try { await tabsDef.find(([k]) => k === tab)[2](holder, show); } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); } };
    content.replaceChildren(pageHead(title, actions), tabs, holder); return show(); };
  const textarea = (value = '', rows = 4) => h('textarea', { rows: String(rows), maxlength: '4000' }, value);
  const KIND = { bilan_medication: 'Bilan de médication', asthme: 'Asthme', anticoagulants: 'Anticoagulants', diabete: 'Diabète', autre: 'Autre' };
  const safePhone = (p) => (p && /^[+\d\s().-]{6,25}$/.test(p) ? p.replace(/[^\d+]/g, '') : null);   // jamais d'URL construite à partir d'une saisie libre

  /** Recherche de patient (nom/téléphone) — nécessite patients:read. */
  function patientPicker(onPick) {
    const input = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher un patient (nom, téléphone)', 'aria-label': 'Rechercher un patient' }); const list = h('div', { class: 'pick hidden' });
    input.addEventListener('input', debounce(async () => {
      if (!input.value.trim()) return list.classList.add('hidden');
      try { const { patients } = await Api.get(`/api/patients?${qs({ q: input.value })}`);
        list.replaceChildren(...(patients.length ? patients.map((p) => h('button', { type: 'button', onclick: () => { onPick({ id: p.id, name: `${p.lastName} ${p.firstName}` }); input.value = ''; list.classList.add('hidden'); } }, h('span', {}, `${p.lastName} ${p.firstName}`), h('span', { class: 'muted small' }, p.phone || ''))) : [h('div', { class: 'empty' }, 'Aucun patient trouvé')]));
        list.classList.remove('hidden'); } catch (e) { toastErr(e); } }));
    return { input, list };
  }

  /* ============================ CRM ============================ */
  const crm = (content) => tabbed(content, 'CRM & Fidélité', [['reminders', 'Rappels', remindersTab], ['loyalty', 'Fidélité', loyaltyTab], ['interviews', 'Entretiens', interviewsTab]], 'reminders');

  async function remindersTab(holder, reload) {
    const status = h('select', { 'aria-label': 'Filtrer par statut' }, [['', 'À traiter (à faire + contactés)'], ['done', 'Terminés'], ['dismissed', 'Ignorés']].map(([v, l]) => h('option', { value: v }, l)));
    const box = h('div', { class: 'card' });
    const msg = `Bonjour, ici ${me.tenantName || 'votre pharmacie'}. Pensez à passer à la pharmacie pour votre renouvellement. À bientôt.`;   // volontairement sans nom de médicament
    const set = async (id, st) => { try { await Api.patch(`/api/crm/reminders/${id}`, { status: st }); load(); } catch (e) { toastErr(e); } };
    const load = async () => {
      const { reminders } = await Api.get(`/api/crm/reminders?${qs({ status: status.value })}`);
      box.replaceChildren(table(['Patient', 'Échéance', 'Produit', 'Statut', 'Contacter', ''], reminders.map((r) => { const ph = safePhone(r.phone); return h('tr', {},
        h('td', {}, h('strong', {}, r.patientName), h('div', { class: 'small muted' }, r.phone || 'pas de téléphone')),
        h('td', {}, fmtDate(r.dueOn), r.daysLate > 0 ? h('div', {}, h('span', { class: 'badge bad' }, `${r.daysLate} j de retard`)) : r.daysLate === 0 ? h('div', {}, h('span', { class: 'badge warn' }, 'aujourd’hui')) : h('div', { class: 'small muted' }, `dans ${-r.daysLate} j`)),
        h('td', { class: 'small' }, r.productName, h('div', { class: 'muted' }, `dernière délivrance ${fmtDate(r.lastOn)}`)), h('td', {}, h('span', { class: `badge ${r.status === 'done' ? 'ok' : r.status === 'contacted' ? 'warn' : ''}` }, { pending: 'À faire', contacted: 'Contacté', done: 'Terminé', dismissed: 'Ignoré' }[r.status])),
        h('td', {}, ph ? h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `tel:${ph}` }, 'Appeler'), h('a', { class: 'btn sm', href: `sms:${ph}?body=${encodeURIComponent(msg)}` }, 'SMS')) : h('span', { class: 'muted small' }, '—')),
        h('td', {}, can('crm:write') && ['pending', 'contacted'].includes(r.status) && h('div', { class: 'row' }, r.status === 'pending' && h('button', { class: 'btn sm', onclick: () => set(r.id, 'contacted') }, 'Contacté'), h('button', { class: 'btn sm success', onclick: () => set(r.id, 'done') }, 'Terminé'), h('button', { class: 'btn sm', onclick: () => set(r.id, 'dismissed') }, 'Ignorer')))); }),
        'Aucun rappel. Renseignez un cycle de renouvellement sur les produits chroniques (fiche produit), puis actualisez.'));
    };
    status.addEventListener('change', () => load().catch(toastErr));
    const gen = can('crm:write') && h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => { try { const r = await Api.post('/api/crm/reminders/generate', {}); toast(`${r.created} nouveau(x) rappel(s)${r.closed ? `, ${r.closed} clos (patient revenu)` : ''}`); load(); } catch (x) { toastErr(x); } }) }, 'Actualiser les rappels');
    holder.replaceChildren(h('div', { class: 'info-box' }, 'Les patients dont le renouvellement arrive à échéance, d’après le cycle indiqué sur chaque produit. Aucun message n’est envoyé automatiquement : « SMS » ouvre l’application de votre téléphone avec un message discret, sans nom de médicament.'), h('div', { class: 'toolbar' }, status, gen), box); await load();
  }

  async function loyaltyTab(holder, reload) {
    const { settings: s } = await Api.get('/api/crm/settings'); const err = errBox();
    const f = { on: h('input', { type: 'checkbox', checked: s.loyaltyEnabled }), earn: h('input', { type: 'number', min: '1', step: '1', value: s.loyaltyEarnAmount }), val: h('input', { type: 'number', min: '1', step: '1', value: s.loyaltyPointValue }), lead: h('input', { type: 'number', min: '0', max: '30', step: '1', value: s.reminderLeadDays }) };
    const save = h('button', { class: 'btn primary', type: 'submit', disabled: !can('crm:write') }, 'Enregistrer');
    const form = h('form', { class: 'card', novalidate: true }, err, h('h2', {}, 'Paramètres'), h('br'), h('label', { class: 'check-list' }, h('span', {}, f.on, ' Programme de fidélité activé')),
      h('div', { class: 'row' }, field('FCFA dépensés pour 1 point', f.earn), field('Valeur d’un point utilisé (FCFA)', f.val), field('Rappels : anticiper de (jours)', f.lead)), save);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { try { await Api.put('/api/crm/settings', { loyaltyEnabled: f.on.checked, loyaltyEarnAmount: Number(f.earn.value), loyaltyPointValue: Number(f.val.value), reminderLeadDays: parseInt(f.lead.value, 10) }); toast('Paramètres enregistrés'); err.classList.add('hidden'); } catch (x) { showErr(err, x); } }); };
    const detail = h('div'); const pk = patientPicker(async (p) => {
      try { const d = await Api.get(`/api/crm/loyalty/${p.id}`);
        detail.replaceChildren(h('div', { class: 'card' }, h('h2', {}, d.patient), h('div', { class: 'stats' }, stat(d.balance, 'Points disponibles', 'green')),
          can('crm:write') && h('button', { class: 'btn', onclick: () => adjust(p) }, 'Corriger le solde'),
          table(['Date', 'Points', 'Motif'], d.entries.map((e) => h('tr', {}, h('td', {}, fmtDateTime(e.date)), h('td', { class: 'num' }, e.points > 0 ? `+${e.points}` : e.points), h('td', {}, e.reason))), 'Aucun mouvement.'))); } catch (x) { toastErr(x); } });
    holder.replaceChildren(form, h('br'), h('h2', {}, 'Solde d’un client'), pk.input, pk.list, detail);
    function adjust(p) {
      const e2 = errBox(); const pts = h('input', { type: 'number', step: '1', required: true, placeholder: 'ex. 10 ou -5' }); const why = h('input', { type: 'text', required: true, placeholder: 'ex. geste commercial, erreur de saisie' }); const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Valider');
      const fm = h('form', { novalidate: true }, e2, h('p', { class: 'muted' }, `Client : ${p.name}. Le registre n’est jamais modifié : la correction ajoute une ligne tracée.`), field('Points (+ ou −)', pts), field('Motif (obligatoire)', why), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), ok));
      const m = modal('Corriger le solde de points', fm);
      fm.onsubmit = (e) => { e.preventDefault(); busy(ok, async () => { try { await Api.post(`/api/crm/loyalty/${p.id}/adjust`, { points: parseInt(pts.value, 10), reason: why.value }); m.close(); toast('Solde corrigé'); reload(); } catch (x) { showErr(e2, x); } }); };
    }
  }

  async function interviewsTab(holder, reload) {
    const mode = h('select', { 'aria-label': 'Filtre' }, [['', 'Entretiens récents'], ['1', 'Suivis à venir (14 jours)']].map(([v, l]) => h('option', { value: v }, l))); const box = h('div', { class: 'card' });
    const load = async () => {
      const { interviews } = await Api.get(`/api/crm/interviews?${qs({ followUps: mode.value })}`);
      box.replaceChildren(table(['Patient', 'Type', 'Date', 'Suivi prévu', 'Pharmacien', ''], interviews.map((i) => h('tr', {}, h('td', {}, h('strong', {}, i.patientName)), h('td', {}, KIND[i.kind]), h('td', {}, fmtDate(i.interviewOn)),
        h('td', {}, i.followUpOn ? h('span', { class: `badge ${i.followUpDone ? 'ok' : 'warn'}` }, `${fmtDate(i.followUpOn)}${i.followUpDone ? ' ✓' : ''}`) : '—'), h('td', { class: 'small' }, i.pharmacist || '—'), h('td', {}, h('button', { class: 'btn sm', onclick: () => openInterview(i.id, reload) }, 'Ouvrir')))), 'Aucun entretien.'));
    };
    mode.addEventListener('change', () => load().catch(toastErr));
    holder.replaceChildren(h('div', { class: 'info-box' }, 'Le contenu des entretiens est chiffré et n’apparaît jamais dans les listes ; chaque ouverture est tracée dans le journal d’audit.'),
      h('div', { class: 'toolbar' }, mode, can('crm:write') && h('button', { class: 'btn primary', onclick: () => interviewForm(reload) }, 'Nouvel entretien')), box); await load();
  }
  async function openInterview(id, reload) {
    try { const { interview: i } = await Api.get(`/api/crm/interviews/${id}`);
      const body = h('div', {}, kv([['Patient', i.patientName], ['Type', KIND[i.kind]], ['Date', fmtDate(i.interviewOn)], ['Pharmacien', i.pharmacist], ['Suivi prévu', i.followUpOn && fmtDate(i.followUpOn)]]), h('strong', {}, 'Compte rendu'), h('p', { class: 'pre' }, i.summary), i.actions && h('strong', {}, 'Actions convenues'), i.actions && h('p', { class: 'pre' }, i.actions),
        h('div', { class: 'actions' }, can('crm:write') && i.followUpOn && !i.followUpDone && h('button', { class: 'btn success', onclick: async () => { try { await Api.patch(`/api/crm/interviews/${id}`, { followUpDone: true }); m.close(); toast('Suivi marqué comme effectué'); reload(); } catch (x) { toastErr(x); } } }, 'Suivi effectué'), closeBtn(() => m)));
      const m = modal('Entretien pharmaceutique', body, { wide: true }); } catch (e) { toastErr(e); }
  }
  function interviewForm(reload) {
    let patient = null; const err = errBox(); const sel = h('div'); const pk = patientPicker((p) => { patient = p; sel.replaceChildren(h('div', { class: 'info-box' }, h('strong', {}, p.name))); });
    const kind = h('select', {}, Object.entries(KIND).map(([k, l]) => h('option', { value: k }, l))); const on = h('input', { type: 'date', required: true, value: iso(new Date()), max: iso(new Date()) }); const fu = h('input', { type: 'date' });
    const sum = textarea(); const act = textarea('', 3); const save = h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer');
    const form = h('form', { novalidate: true }, err, h('strong', {}, 'Patient'), pk.input, pk.list, sel, h('div', { class: 'row' }, field('Type', kind), field('Date', on), field('Suivi prévu', fu)), field('Compte rendu', sum), field('Actions convenues', act), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvel entretien pharmaceutique', form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { if (!patient) return showErr(err, new Error('Sélectionnez un patient'));
      try { await Api.post('/api/crm/interviews', { patientId: patient.id, kind: kind.value, interviewOn: on.value, followUpOn: fu.value || null, summary: sum.value, actions: act.value }); m.close(); toast('Entretien enregistré'); reload(); } catch (x) { showErr(err, x); } }); };
  }

  /* ============================ RH ============================ */
  const rh = (content) => tabbed(content, 'RH & Planning', [['planning', 'Planning', planningTab], ['absences', 'Absences', absencesTab], ['hours', 'Heures', hoursTab]], 'planning');
  const SHIFT_KIND = { normal: 'Normal', garde: 'Garde', astreinte: 'Astreinte' }; const ABS_KIND = { conge: 'Congé', maladie: 'Maladie', autre: 'Autre' };
  let weekStart = mondayOf(iso(new Date()));

  async function planningTab(holder, reload) {
    const { staff } = await Api.get('/api/rh/staff'); const { shifts, absences } = await Api.get(`/api/rh/shifts?${qs({ from: weekStart, to: addDays(weekStart, 6) })}`);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)); const DN = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const cell = (u, d) => h('td', { class: 'wk-cell' },
      absences.filter((a) => a.userId === u.id && a.startDate <= d && d <= a.endDate).map((a) => h('div', {}, h('span', { class: 'badge bad' }, `Absent (${ABS_KIND[a.kind]})`))),
      shifts.filter((s) => s.userId === u.id && s.date === d).map((s) => h('button', { class: `chip-btn${s.kind === 'garde' ? ' garde' : ''}`, type: 'button', title: can('rh:write') ? 'Cliquer pour supprimer' : '', onclick: async () => { if (!can('rh:write') || !confirm(`Supprimer le créneau ${s.start}–${s.end} de ${u.name} ?`)) return; try { await Api.del(`/api/rh/shifts/${s.id}`); toast('Créneau supprimé'); reload(); } catch (x) { toastErr(x); } } }, `${s.start}–${s.end}`, s.kind !== 'normal' ? ` · ${SHIFT_KIND[s.kind]}` : '')),
      can('rh:write') && h('button', { class: 'chip-add', type: 'button', 'aria-label': `Ajouter un créneau pour ${u.name} le ${fmtDate(d)}`, onclick: () => shiftForm(u, d, reload) }, '+'));
    holder.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', onclick: () => { weekStart = addDays(weekStart, -7); reload(); } }, '← Semaine précédente'), h('strong', {}, `Semaine du ${fmtDate(weekStart)}`), h('button', { class: 'btn sm', onclick: () => { weekStart = addDays(weekStart, 7); reload(); } }, 'Semaine suivante →'), h('button', { class: 'btn sm', onclick: () => { weekStart = mondayOf(iso(new Date())); reload(); } }, 'Aujourd’hui')),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'week' }, h('thead', {}, h('tr', {}, h('th', {}, 'Équipe'), days.map((d, i) => h('th', { scope: 'col' }, `${DN[i]} ${d.slice(8)}/${d.slice(5, 7)}`)))), h('tbody', {}, staff.map((u) => h('tr', {}, h('th', { scope: 'row' }, u.name), days.map((d) => cell(u, d))))))));
  }
  function shiftForm(u, date, reload) {
    const err = errBox(); const d = h('input', { type: 'date', required: true, value: date }); const st = h('input', { type: 'time', required: true, value: '08:00' }); const en = h('input', { type: 'time', required: true, value: '16:00' }); const kind = h('select', {}, Object.entries(SHIFT_KIND).map(([k, l]) => h('option', { value: k }, l)));
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, `${u.name}. Une heure de fin inférieure ou égale au début signifie « le lendemain » (garde de nuit).`), field('Date', d), h('div', { class: 'row' }, field('Début', st), field('Fin', en)), field('Type', kind), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouveau créneau', form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { try { await Api.post('/api/rh/shifts', { userId: u.id, date: d.value, start: st.value, end: en.value, kind: kind.value }); m.close(); toast('Créneau ajouté'); reload(); } catch (x) { showErr(err, x); } }); };
  }

  async function absencesTab(holder, reload) {
    const from = iso(new Date()); const [{ absences }, { staff }] = await Promise.all([Api.get(`/api/rh/shifts?${qs({ from, to: addDays(from, 90) })}`), can('rh:write') ? Api.get('/api/rh/staff') : { staff: [] }]);
    holder.replaceChildren(h('div', { class: 'toolbar' }, can('rh:write') && h('button', { class: 'btn primary', onclick: () => absenceForm(staff, reload) }, 'Nouvelle absence')),
      h('div', { class: 'card' }, table(['Employé', 'Du', 'Au', 'Type', ''], absences.map((a) => h('tr', {}, h('td', {}, h('strong', {}, a.name)), h('td', {}, fmtDate(a.startDate)), h('td', {}, fmtDate(a.endDate)), h('td', {}, ABS_KIND[a.kind]),
        h('td', {}, can('rh:write') && h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Supprimer cette absence ?')) return; try { await Api.del(`/api/rh/absences/${a.id}`); toast('Absence supprimée'); reload(); } catch (x) { toastErr(x); } } }, 'Supprimer')))), 'Aucune absence à venir (90 jours).')));
  }
  function absenceForm(staff, reload) {
    const err = errBox(); const u = h('select', {}, staff.map((s) => h('option', { value: s.id }, s.name))); const a = h('input', { type: 'date', required: true, value: iso(new Date()) }); const b = h('input', { type: 'date', required: true, value: iso(new Date()) }); const kind = h('select', {}, Object.entries(ABS_KIND).map(([k, l]) => h('option', { value: k }, l)));
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer');
    const form = h('form', { novalidate: true }, err, field('Employé', u), h('div', { class: 'row' }, field('Du', a), field('Au', b)), field('Type', kind), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvelle absence', form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { try { const r = await Api.post('/api/rh/absences', { userId: u.value, startDate: a.value, endDate: b.value, kind: kind.value }); m.close();
      toast(r.conflictingShifts.length ? `Absence enregistrée — attention : ${r.conflictingShifts.length} créneau(x) planifié(s) pendant cette absence` : 'Absence enregistrée', r.conflictingShifts.length > 0); reload(); } catch (x) { showErr(err, x); } }); };
  }

  async function hoursTab(holder, reload) {
    const from = h('input', { type: 'date', value: addDays(iso(new Date()), -29), 'aria-label': 'Début' }); const to = h('input', { type: 'date', value: iso(new Date()), 'aria-label': 'Fin' }); const box = h('div', { class: 'card' });
    const load = async () => {
      const { hours } = await Api.get(`/api/rh/hours?${qs({ from: from.value, to: to.value })}`);
      box.replaceChildren(table(['Employé', 'Heures pointées', 'Heures planifiées', 'Pointage ouvert', ''], hours.map((x) => h('tr', {}, h('td', {}, h('strong', {}, x.name)), h('td', { class: 'num' }, `${x.workedHours} h`), h('td', { class: 'num' }, `${x.plannedHours} h`), h('td', {}, x.openEntries ? h('span', { class: 'badge warn' }, `${x.openEntries} à clore`) : '—'), h('td', {}, h('button', { class: 'btn sm', onclick: () => entriesDialog(x, from.value, to.value, load) }, 'Détail')))), 'Aucun employé.'));
    };
    holder.replaceChildren(h('div', { class: 'toolbar' }, field('Du', from), field('Au', to), h('button', { class: 'btn primary', onclick: () => load().catch(toastErr) }, 'Afficher')), box); await load();
  }
  async function entriesDialog(u, from, to, reload) {
    try { const { entries } = await Api.get(`/api/rh/time-entries?${qs({ userId: u.userId, from, to })}`);
      const body = h('div', {}, table(['Arrivée', 'Départ', ''], entries.map((e) => h('tr', {}, h('td', {}, fmtDateTime(e.clockIn)), h('td', {}, e.clockOut ? fmtDateTime(e.clockOut) : h('span', { class: 'badge warn' }, 'en cours')), h('td', {}, can('rh:write') && h('button', { class: 'btn sm', onclick: () => { m.close(); correctForm(e, u, from, to, reload); } }, 'Corriger')))), 'Aucun pointage sur la période.'), h('div', { class: 'actions' }, closeBtn(() => m)));
      const m = modal(`Pointages — ${u.name}`, body, { wide: true }); } catch (e) { toastErr(e); }
  }
  function correctForm(e, u, from, to, reload) {
    const loc = (s) => UI.toInputValue(s);   // heure de la pharmacie, pas celle de l'appareil
    const err = errBox(); const a = h('input', { type: 'datetime-local', required: true, value: loc(e.clockIn) }); const b = h('input', { type: 'datetime-local', value: loc(e.clockOut) }); const why = h('input', { type: 'text', required: true, placeholder: 'ex. oubli de pointage' }); const save = h('button', { class: 'btn primary', type: 'submit' }, 'Corriger');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, 'La correction est tracée (valeurs avant/après et motif).'), h('div', { class: 'row' }, field('Arrivée', a), field('Départ', b)), field('Motif (obligatoire)', why), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Corriger un pointage', form);
    form.onsubmit = (ev) => { ev.preventDefault(); busy(save, async () => { try { await Api.patch(`/api/rh/time-entries/${e.id}`, { clockIn: UI.fromInputValue(a.value), clockOut: b.value ? UI.fromInputValue(b.value) : null, reason: why.value }); m.close(); toast('Pointage corrigé'); reload(); } catch (x) { showErr(err, x); } }); };
  }

  window.ModuleViews = { ...(window.ModuleViews || {}), crm, rh };
})();
