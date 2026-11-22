'use strict';
/** Vues des modules métier (Phase 2) : Patients, Stocks & Inventaire, Dispensation. */
(() => {
  const { h, toast, modal, field, fmtDate, fmtDateTime } = UI;
  const can = (p) => me.permissions.includes(p);
  const money = (n) => `${Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} FCFA`;
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  const toastErr = (e) => toast(e.message, true);
  const closeBtn = (getModal, label = 'Fermer') => h('button', { class: 'btn', type: 'button', onclick: () => getModal().close() }, label); // getModal différé : la modale n'existe pas encore à la construction
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const allergyChips = (list) => list.length ? h('div', { class: 'chips' }, list.map((a) => h('span', { class: 'badge bad' }, a))) : h('span', { class: 'muted' }, 'Aucune allergie déclarée');

  /* ======================= PATIENTS ======================= */
  async function patients(content) {
    const q = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher : nom, prénom, téléphone', 'aria-label': 'Rechercher un patient' });
    const holder = h('div', { class: 'card' });
    async function load() {
      try {
        const { patients: list } = await Api.get(`/api/patients?${qs({ q: q.value })}`);
        holder.replaceChildren(table(['Patient', 'Naissance', 'Téléphone', 'Allergies', ''], list.map((p) => h('tr', {},
          h('td', {}, h('strong', {}, `${p.lastName} ${p.firstName}`)), h('td', {}, fmtDate(p.birthDate)), h('td', {}, p.phone || '—'),
          h('td', {}, p.allergies.length ? allergyChips(p.allergies) : h('span', { class: 'muted' }, '—')),
          h('td', {}, h('button', { class: 'btn sm', onclick: () => patientDetail(p.id, load) }, 'Ouvrir')))), q.value ? 'Aucun patient ne correspond à cette recherche.' : 'Aucun patient enregistré. Créez le premier dossier.'));
      } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    q.addEventListener('input', debounce(load));
    content.replaceChildren(pageHead('Patients', can('patients:write') && h('button', { class: 'btn primary', onclick: () => patientForm(null, load) }, 'Nouveau patient')), h('div', { class: 'toolbar' }, q), holder);
    await load();
  }

  async function patientDetail(id, reload) {
    try {
      const { patient: p, history } = await Api.get(`/api/patients/${id}`);
      const body = h('div', {}, kv([['Naissance', p.birthDate && fmtDate(p.birthDate)], ['Sexe', p.sex === 'F' ? 'Féminin' : p.sex === 'M' ? 'Masculin' : null], ['Téléphone', p.phone], ['Adresse', p.address],
        ['Assurance', [p.insuranceProvider, p.insuranceNumber].filter(Boolean).join(' — ')], ['Contre-indications', p.contraindications], ['Notes', p.notes]]),
        h('strong', {}, 'Allergies'), h('div', {}, allergyChips(p.allergies)), h('br'), h('strong', {}, 'Historique des ordonnances'),
        table(['N°', 'Date', 'Prescripteur', 'Statut', 'Produits'], history.map((r) => h('tr', {}, h('td', {}, `ORD-${String(r.number).padStart(6, '0')}`), h('td', {}, fmtDate(r.prescribed_on)), h('td', {}, r.prescriber_name),
          h('td', {}, rxBadge(r.status)), h('td', { class: 'small' }, r.items.map((i) => `${i.product} ×${i.quantity}`).join(', ')))), 'Aucune ordonnance pour ce patient.'),
        h('div', { class: 'actions' }, can('patients:delete') && p.isActive && h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Archiver ce dossier ? Il restera consultable dans l’historique.')) return; try { await Api.del(`/api/patients/${id}`); m.close(); toast('Dossier archivé'); reload(); } catch (e) { toastErr(e); } } }, 'Archiver'),
          can('patients:write') && h('button', { class: 'btn', onclick: () => { m.close(); patientForm(p, reload); } }, 'Modifier'), closeBtn(() => m)));
      const m = modal(`${p.lastName} ${p.firstName}`, body, { wide: true });
    } catch (e) { toastErr(e); }
  }

  function patientForm(p, reload) {
    const err = errBox(); const editing = !!p;
    const f = {
      lastName: h('input', { type: 'text', required: true, value: p?.lastName || '' }), firstName: h('input', { type: 'text', required: true, value: p?.firstName || '' }),
      birthDate: h('input', { type: 'date', value: p?.birthDate || '' }), sex: h('select', {}, [['', '—'], ['F', 'Féminin'], ['M', 'Masculin']].map(([v, l]) => h('option', { value: v, selected: (p?.sex || '') === v }, l))),
      phone: h('input', { type: 'tel', value: p?.phone || '' }), address: h('input', { type: 'text', value: p?.address || '' }),
      insuranceProvider: h('input', { type: 'text', value: p?.insuranceProvider || '' }), insuranceNumber: h('input', { type: 'text', value: p?.insuranceNumber || '' }),
      allergies: h('input', { type: 'text', value: (p?.allergies || []).join(', ') }), contraindications: h('input', { type: 'text', value: p?.contraindications || '' }),
      notes: h('input', { type: 'text', value: p?.notes || '' }),
    };
    const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Enregistrer' : 'Créer le dossier');
    const form = h('form', { novalidate: true }, err,
      h('div', { class: 'row' }, field('Nom', f.lastName), field('Prénom', f.firstName)), h('div', { class: 'row' }, field('Date de naissance', f.birthDate), field('Sexe', f.sex), field('Téléphone', f.phone)),
      field('Adresse', f.address), h('div', { class: 'row' }, field('Organisme d’assurance', f.insuranceProvider), field('N° d’assuré', f.insuranceNumber, 'Stocké chiffré')),
      field('Allergies', f.allergies, 'Séparées par des virgules. Utilisées pour les alertes à la dispensation (ex. amoxicilline, paracétamol).'),
      field('Contre-indications', f.contraindications), field('Notes', f.notes, 'Stockées chiffrées'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(editing ? 'Modifier le patient' : 'Nouveau patient', form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      const body = { lastName: f.lastName.value, firstName: f.firstName.value, birthDate: f.birthDate.value || null, sex: f.sex.value || null, phone: f.phone.value, address: f.address.value,
        insuranceProvider: f.insuranceProvider.value, insuranceNumber: f.insuranceNumber.value, allergies: f.allergies.value.split(',').map((s) => s.trim()).filter(Boolean),
        contraindications: f.contraindications.value, notes: f.notes.value };
      try { editing ? await Api.patch(`/api/patients/${p.id}`, body) : await Api.post('/api/patients', body); m.close(); toast(editing ? 'Dossier modifié' : 'Dossier créé'); reload(); } catch (x) { showErr(err, x); }
    }); };
  }

  /* ======================= STOCKS ======================= */
  const STOCK_BADGE = { rupture: ['Rupture', 'bad'], bas: ['Stock bas', 'warn'], ok: ['OK', 'ok'] };
  const EXP_BADGE = { perime: ['Périmé', 'bad'], proche: ['Péremption proche', 'warn'], ok: ['Valide', 'ok'] };

  async function stocks(content) {
    const q = h('input', { class: 'search', type: 'search', placeholder: 'Produit, DCI ou code-barres', 'aria-label': 'Rechercher un produit' });
    const status = h('select', { 'aria-label': 'Filtrer par statut' }, [['', 'Tous les produits'], ['rupture', 'En rupture'], ['bas', 'Stock bas']].map(([v, l]) => h('option', { value: v }, l)));
    const statsBox = h('div', { class: 'stats' }); const alertsBox = h('div'); const holder = h('div', { class: 'card' });
    async function load() {
      try {
        const [{ products }, al] = await Promise.all([Api.get(`/api/stocks/products?${qs({ q: q.value, status: status.value })}`), Api.get('/api/stocks/alerts')]);
        statsBox.replaceChildren(stat(al.totals.products, 'Produits actifs'), stat(al.outOfStock.length, 'En rupture', al.outOfStock.length ? 'red' : ''), stat(al.low.length, 'Stock bas', al.low.length ? 'warn' : ''), stat(al.expiring.length + al.expired.length, 'Lots à péremption proche ou périmés', al.expired.length ? 'red' : al.expiring.length ? 'warn' : ''));
        const lots = [...al.expired, ...al.expiring].slice(0, 8);
        alertsBox.replaceChildren(lots.length ? h('div', { class: 'card' }, h('h2', {}, 'Péremptions à traiter'), table(['Produit', 'Lot', 'Péremption', 'Quantité', ''], lots.map((l) => h('tr', {}, h('td', {}, l.name), h('td', {}, l.lot_number), h('td', {}, fmtDate(l.expiry_date)), h('td', {}, l.quantity), h('td', {}, h('span', { class: `badge ${EXP_BADGE[l.expiryStatus][1]}` }, EXP_BADGE[l.expiryStatus][0]))))), h('br')) : h('span'));
        holder.replaceChildren(table(['Produit', 'Disponible', 'Seuil min', 'Statut', 'Prochaine péremption', 'Prix de vente', ''], products.map((p) => h('tr', {},
          h('td', {}, h('strong', {}, p.name), h('div', { class: 'small muted' }, [p.dci, p.form, p.dosage].filter(Boolean).join(' · '))), h('td', { class: 'num' }, p.available), h('td', { class: 'num' }, p.minStock),
          h('td', {}, h('span', { class: `badge ${STOCK_BADGE[p.status][1]}` }, STOCK_BADGE[p.status][0])), h('td', {}, fmtDate(p.nextExpiry)), h('td', { class: 'num' }, money(p.salePrice)),
          h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => productDetail(p.id, load) }, 'Lots'), can('stocks:write') && h('button', { class: 'btn sm success', onclick: () => receiveForm(p, load) }, 'Réceptionner'))))),
          q.value || status.value ? 'Aucun produit ne correspond.' : 'Aucun produit au catalogue. Créez votre premier produit.'));
      } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    q.addEventListener('input', debounce(load)); status.addEventListener('change', load);
    content.replaceChildren(pageHead('Stocks & Inventaire', can('stocks:write') && h('button', { class: 'btn primary', onclick: () => productForm(null, load) }, 'Nouveau produit')), statsBox, alertsBox, h('div', { class: 'toolbar' }, q, status), holder);
    await load();
  }

  function productForm(p, reload) {
    const err = errBox(); const editing = !!p;
    const f = { name: h('input', { type: 'text', required: true, value: p?.name || '' }), dci: h('input', { type: 'text', value: p?.dci || '' }), barcode: h('input', { type: 'text', value: p?.barcode || '' }),
      form: h('input', { type: 'text', value: p?.form || '', placeholder: 'comprimé, sirop…' }), dosage: h('input', { type: 'text', value: p?.dosage || '', placeholder: '500 mg' }),
      sale: h('input', { type: 'number', min: '0', step: '1', value: p?.salePrice ?? 0 }), purchase: h('input', { type: 'number', min: '0', step: '1', value: p?.purchasePrice ?? 0 }),
      min: h('input', { type: 'number', min: '0', step: '1', value: p?.minStock ?? 0 }), renew: h('input', { type: 'number', min: '1', max: '365', step: '1', value: p?.renewalDays ?? '', placeholder: 'ex. 30' }), rx: h('input', { type: 'checkbox', checked: !!p?.requiresPrescription }), gen: h('input', { type: 'checkbox', checked: !!p?.isGeneric }), ctl: h('input', { type: 'checkbox', checked: !!p?.isControlled }) };
    const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Enregistrer' : 'Créer le produit');
    const form = h('form', { novalidate: true }, err, field('Nom commercial', f.name), h('div', { class: 'row' }, field('DCI (principe actif)', f.dci, 'Sert aux alertes d’allergie'), field('Code-barres', f.barcode)),
      h('div', { class: 'row' }, field('Forme', f.form), field('Dosage', f.dosage)), h('div', { class: 'row' }, field('Prix d’achat (FCFA)', f.purchase), field('Prix de vente (FCFA)', f.sale), field('Seuil d’alerte', f.min, 'Alerte « stock bas » à ce niveau')),
      field('Cycle de renouvellement (jours)', f.renew, 'Pour les traitements chroniques : sert aux rappels du module CRM. Laisser vide sinon.'),
      h('label', { class: 'check-list' }, h('span', {}, f.rx, ' Délivrance sur ordonnance uniquement')),
      h('label', { class: 'check-list' }, h('span', {}, f.gen, ' Médicament générique')),
      h('label', { class: 'check-list' }, h('span', {}, f.ctl, ' Produit contrôlé (inscrit au registre : stupéfiants, etc.)')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(editing ? 'Modifier le produit' : 'Nouveau produit', form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      const body = { name: f.name.value, dci: f.dci.value, barcode: f.barcode.value, form: f.form.value, dosage: f.dosage.value, salePrice: Number(f.sale.value), purchasePrice: Number(f.purchase.value), minStock: parseInt(f.min.value, 10) || 0, renewalDays: f.renew.value ? parseInt(f.renew.value, 10) : null, requiresPrescription: f.rx.checked, isGeneric: f.gen.checked, isControlled: f.ctl.checked };
      try { editing ? await Api.patch(`/api/stocks/products/${p.id}`, body) : await Api.post('/api/stocks/products', body); m.close(); toast(editing ? 'Produit modifié' : 'Produit créé'); reload(); } catch (x) { showErr(err, x); }
    }); };
  }

  function receiveForm(p, reload) {
    const err = errBox(); const lot = h('input', { type: 'text', required: true }); const exp = h('input', { type: 'date', required: true }); const qty = h('input', { type: 'number', min: '1', step: '1', required: true });
    const save = h('button', { class: 'btn success', type: 'submit' }, 'Enregistrer l’entrée');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, 'Si le n° de lot existe déjà, la quantité est ajoutée à ce lot.'), field('N° de lot', lot), h('div', { class: 'row' }, field('Date de péremption', exp), field('Quantité reçue', qty)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(`Réception — ${p.name}`, form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      try { await Api.post('/api/stocks/receive', { productId: p.id, lotNumber: lot.value, expiryDate: exp.value, quantity: parseInt(qty.value, 10) }); m.close(); toast('Entrée enregistrée'); reload(); } catch (x) { showErr(err, x); }
    }); };
  }

  async function productDetail(id, reload) {
    try {
      const { product: p, lots, movements } = await Api.get(`/api/stocks/products/${id}`);
      const typeLabel = { reception: 'Réception', adjustment: 'Ajustement', dispensation: 'Dispensation', sale: 'Vente comptoir', return: 'Retour client', transfer_out: 'Transfert sortant', transfer_in: 'Transfert entrant', transfer_return: 'Retour de transfert' };
      const body = h('div', {}, kv([['DCI', p.dci], ['Forme / dosage', [p.form, p.dosage].filter(Boolean).join(' ')], ['Code-barres', p.barcode], ['Disponible', `${p.available} (hors lots périmés)`], ['Prix de vente', money(p.salePrice)]]),
        h('strong', {}, 'Lots (sortie dans l’ordre de péremption)'),
        table(['Lot', 'Péremption', 'Quantité', 'Statut', ''], lots.map((l) => h('tr', {}, h('td', {}, l.lot_number), h('td', {}, fmtDate(l.expiry_date)), h('td', { class: 'num' }, l.quantity),
          h('td', {}, h('span', { class: `badge ${EXP_BADGE[l.expiryStatus][1]}` }, EXP_BADGE[l.expiryStatus][0])), h('td', {}, can('stocks:adjust') && h('button', { class: 'btn sm', onclick: () => adjustForm(l, () => { m.close(); reload(); productDetail(id, reload); }) }, 'Ajuster')))), 'Aucun lot en stock.'),
        h('br'), h('strong', {}, 'Derniers mouvements'),
        table(['Date', 'Type', 'Lot', 'Quantité', 'Motif', 'Par'], movements.map((x) => h('tr', {}, h('td', {}, fmtDateTime(x.created_at)), h('td', {}, typeLabel[x.type] || x.type), h('td', {}, x.lot_number || '—'), h('td', { class: 'num' }, x.quantity > 0 ? `+${x.quantity}` : x.quantity), h('td', {}, x.reason || '—'), h('td', { class: 'small muted' }, x.user_email || '—'))), 'Aucun mouvement.'),
        h('div', { class: 'actions' }, can('stocks:write') && h('button', { class: 'btn', onclick: () => { m.close(); productForm(p, reload); } }, 'Modifier le produit'), closeBtn(() => m)));
      const m = modal(p.name, body, { wide: true });
    } catch (e) { toastErr(e); }
  }

  function adjustForm(l, done) {
    const err = errBox(); const qty = h('input', { type: 'number', min: '0', step: '1', required: true, value: l.quantity }); const reason = h('input', { type: 'text', required: true, placeholder: 'Inventaire, casse, erreur de saisie…' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Valider l’ajustement');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, `Lot ${l.lot_number} — quantité actuelle : ${l.quantity}`), field('Quantité réelle constatée', qty), field('Motif (obligatoire)', reason, 'L’ajustement est tracé dans les mouvements et le journal d’audit.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Ajuster le stock', form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      try { await Api.post('/api/stocks/adjust', { lotId: l.id, newQuantity: parseInt(qty.value, 10), reason: reason.value }); m.close(); toast('Stock ajusté'); done(); } catch (x) { showErr(err, x); }
    }); };
  }

  /* ======================= DISPENSATION ======================= */
  const RX_STATUS = { pending: ['À valider', 'warn'], validated: ['Validée', ''], dispensed: ['Délivrée', 'ok'], cancelled: ['Annulée', 'bad'] };
  const rxBadge = (s) => h('span', { class: `badge ${RX_STATUS[s][1]}` }, RX_STATUS[s][0]);

  async function dispensation(content) {
    const status = h('select', { 'aria-label': 'Filtrer par statut' }, [['', 'Toutes les ordonnances'], ['pending', 'À valider'], ['validated', 'Validées'], ['dispensed', 'Délivrées'], ['cancelled', 'Annulées']].map(([v, l]) => h('option', { value: v }, l)));
    const holder = h('div', { class: 'card' });
    async function load() {
      try {
        const { prescriptions } = await Api.get(`/api/dispensation/prescriptions?${qs({ status: status.value })}`);
        holder.replaceChildren(table(['N°', 'Patient', 'Prescripteur', 'Date', 'Statut', 'Alertes', ''], prescriptions.map((r) => h('tr', {}, h('td', {}, h('strong', {}, r.number)), h('td', {}, r.patientName), h('td', {}, r.prescriberName), h('td', {}, fmtDate(r.prescribedOn)),
          h('td', {}, rxBadge(r.status)), h('td', {}, r.alerts.length ? h('span', { class: 'badge bad' }, `${r.alerts.length} alerte(s)`) : '—'), h('td', {}, h('button', { class: 'btn sm', onclick: () => rxDetail(r.id, load) }, 'Ouvrir')))), 'Aucune ordonnance.'));
      } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    status.addEventListener('change', load);
    content.replaceChildren(pageHead('Dispensation', can('dispensation:write') && h('button', { class: 'btn primary', onclick: () => rxForm(load) }, 'Nouvelle ordonnance')),
      h('div', { class: 'info-box' }, 'Circuit : saisie → validation par un pharmacien → délivrance (sortie de stock par lot, péremption la plus proche en premier).'), h('div', { class: 'toolbar' }, status), holder);
    await load();
  }

  /** Alertes groupées par gravité : danger (justification écrite exigée), précaution, information. */
  function alertBox(alerts) {
    if (!alerts.length) return null;
    const box = (level, title, cls) => { const l = alerts.filter((a) => a.level === level); return l.length ? h('div', { class: cls, role: level === 'danger' ? 'alert' : null }, h('strong', {}, title),
      h('ul', {}, l.map((a) => h('li', {}, a.message, a.recommendation ? h('div', { class: 'small' }, `Conduite : ${a.recommendation}`) : null)))) : null; };
    return h('div', {}, box('danger', 'Alertes graves', 'alert-box'), box('warning', 'Précautions', 'alert-box warn'), box('info', 'Informations', 'info-box'));
  }

  function rxForm(reload) {
    const err = errBox(); let patient = null; const items = new Map(); // productId → {product, qtyInput, posoInput}
    const pq = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher le patient (nom, téléphone)', 'aria-label': 'Rechercher un patient' }); const pList = h('div', { class: 'pick hidden' }); const pSel = h('div');
    const prescriber = h('input', { type: 'text', required: true }); const on = h('input', { type: 'date', required: true, value: UI.today(), max: UI.today() });
    const gq = h('input', { class: 'search', type: 'search', placeholder: 'Ajouter un produit (nom, DCI, code-barres)', 'aria-label': 'Rechercher un produit' }); const gList = h('div', { class: 'pick hidden' }); const body = h('tbody');
    const itemsWrap = h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Produit', 'Quantité', 'Posologie', ''].map((x) => h('th', { scope: 'col' }, x)))), body));
    const notes = h('input', { type: 'text' }); const save = h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer l’ordonnance');

    const showPatient = () => pSel.replaceChildren(patient ? h('div', { class: 'info-box' }, h('strong', {}, patient.name), ' ', patient.birthDate ? `(né(e) le ${fmtDate(patient.birthDate)})` : '', h('div', {}, allergyChips(patient.allergies))) : h('span'));
    pq.addEventListener('input', debounce(async () => {
      if (!pq.value.trim()) return pList.classList.add('hidden');
      try { const { patients: ps } = await Api.get(`/api/dispensation/lookup/patients?${qs({ q: pq.value })}`);
        pList.replaceChildren(...(ps.length ? ps.map((x) => h('button', { type: 'button', onclick: () => { patient = x; pList.classList.add('hidden'); pq.value = ''; showPatient(); } }, h('span', {}, x.name), h('span', { class: 'muted small' }, x.birthDate ? fmtDate(x.birthDate) : ''))) : [h('div', { class: 'empty' }, 'Aucun patient trouvé')]));
        pList.classList.remove('hidden'); } catch (x) { showErr(err, x); } }));
    const renderItems = () => body.replaceChildren(...[...items.values()].map((it) => h('tr', {}, h('td', {}, h('strong', {}, it.product.name), h('div', { class: 'small muted' }, `Disponible : ${it.product.available}`)), h('td', {}, it.qty), h('td', {}, it.poso),
      h('td', {}, h('button', { class: 'btn sm danger', type: 'button', onclick: () => { items.delete(it.product.id); renderItems(); } }, 'Retirer')))));
    gq.addEventListener('input', debounce(async () => {
      if (!gq.value.trim()) return gList.classList.add('hidden');
      try { const { products } = await Api.get(`/api/dispensation/lookup/products?${qs({ q: gq.value })}`);
        gList.replaceChildren(...(products.length ? products.map((x) => h('button', { type: 'button', onclick: () => { if (!items.has(x.id)) items.set(x.id, { product: x, qty: h('input', { class: 'qty', type: 'number', min: '1', step: '1', value: '1', 'aria-label': `Quantité ${x.name}` }), poso: h('input', { class: 'poso', type: 'text', placeholder: 'ex. 1 comprimé 3 fois par jour pendant 7 jours', 'aria-label': `Posologie ${x.name}` }) }); gList.classList.add('hidden'); gq.value = ''; renderItems(); } },
          h('span', {}, `${x.name}${x.dosage ? ' ' + x.dosage : ''}`, x.dci ? h('span', { class: 'muted small' }, ` — ${x.dci}`) : null), h('span', { class: x.available ? 'muted small' : 'badge bad' }, x.available ? `${x.available} en stock` : 'Rupture'))) : [h('div', { class: 'empty' }, 'Aucun produit trouvé')]));
        gList.classList.remove('hidden'); } catch (x) { showErr(err, x); } }));

    const form = h('form', { novalidate: true }, err, h('strong', {}, 'Patient'), pq, pList, pSel, h('div', { class: 'row' }, field('Prescripteur', prescriber), field('Date de prescription', on)),
      h('strong', {}, 'Produits prescrits'), gq, gList, itemsWrap, field('Notes', notes), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvelle ordonnance', form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      if (!patient) return showErr(err, new Error('Sélectionnez un patient'));
      if (!items.size) return showErr(err, new Error('Ajoutez au moins un produit'));
      try {
        const r = await Api.post('/api/dispensation/prescriptions', { patientId: patient.id, prescriberName: prescriber.value, prescribedOn: on.value, notes: notes.value,
          items: [...items.values()].map((it) => ({ productId: it.product.id, quantity: parseInt(it.qty.value, 10), posology: it.poso.value })) });
        m.close(); toast(`Ordonnance ${r.number} enregistrée${r.alerts.length ? ` — ${r.alerts.length} alerte(s) à examiner` : ''}`, r.alerts.length > 0); reload();
      } catch (x) { showErr(err, x); }
    }); };
  }

  async function rxDetail(id, reload) {
    try {
      const { prescription: r, items } = await Api.get(`/api/dispensation/prescriptions/${id}`);
      const act = (label, cls, fn) => h('button', { class: `btn ${cls}`, onclick: (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (x) { toastErr(x); } }) }, label);
      const refresh = () => { m.close(); reload(); rxDetail(id, reload); };
      const validate = async (body) => { await Api.post(`/api/dispensation/prescriptions/${id}/validate`, body); toast('Ordonnance validée'); refresh(); };
      const actions = [];
      if (r.status === 'pending' && can('dispensation:validate')) actions.push(act('Valider (contrôle pharmacien)', 'success', async () => {
        try { await validate({}); } catch (x) {
          if (x.code !== 'ALERTS_REQUIRE_ACK' && x.code !== 'NOTE_REQUIRED') throw x;
          const msg = x.alerts.filter((a) => a.level !== 'info').map((a) => `• ${a.message}`).join('\n');
          if (!confirm(`${msg}\n\nConfirmez-vous avoir examiné ces alertes ?`)) return;
          let note = '';
          if (x.requiresNote) { note = (prompt('Alerte grave : justification écrite obligatoire (5 caractères minimum) :') || '').trim(); if (note.length < 5) return toast('Justification requise : validation annulée', true); }
          await validate({ acknowledgeAlerts: true, note });
        }
      }));
      if (r.status === 'validated' && can('dispensation:write')) actions.push(act('Délivrer et sortir du stock', 'primary', async () => { await Api.post(`/api/dispensation/prescriptions/${id}/dispense`, {}); toast('Ordonnance délivrée, stock mis à jour'); refresh(); }));
      if (['validated', 'dispensed'].includes(r.status)) actions.push(h('button', { class: 'btn', onclick: () => labelsDialog(id) }, 'Étiquettes'));
      if (['pending', 'validated'].includes(r.status) && can('dispensation:write')) actions.push(act('Annuler', 'danger', async () => { const reason = prompt('Motif de l’annulation :'); if (!reason) return; await Api.post(`/api/dispensation/prescriptions/${id}/cancel`, { reason }); toast('Ordonnance annulée'); refresh(); }));
      const canSub = r.status === 'pending' && can('dispensation:write');
      const body = h('div', {}, h('p', {}, rxBadge(r.status)), kv([['Patient', r.patientName], ['Prescripteur', r.prescriberName], ['Date', fmtDate(r.prescribedOn)], ['Notes', r.notes], ['Motif d’annulation', r.cancelledReason], ['Délivrée le', r.dispensedAt && fmtDateTime(r.dispensedAt)]]), alertBox(r.alerts),
        table(['Produit', 'Quantité', 'Posologie', 'Stock disponible', ''], items.map((i) => h('tr', {}, h('td', {}, h('strong', {}, i.name), i.is_generic && h('span', { class: 'badge ok' }, 'Générique'), h('div', { class: 'small muted' }, [i.dci, i.dosage].filter(Boolean).join(' · ')), i.substituted_from_name && h('div', { class: 'small' }, `Substitué à : ${i.substituted_from_name}`)), h('td', { class: 'num' }, i.quantity), h('td', {}, i.posology || '—'),
          h('td', {}, ['pending', 'validated'].includes(r.status) && i.available < i.quantity ? h('span', { class: 'badge bad' }, `Insuffisant (${i.available})`) : String(i.available)), h('td', {}, canSub && h('button', { class: 'btn sm', onclick: () => substitutesDialog(id, i, () => { m.close(); reload(); rxDetail(id, reload); }) }, 'Substituts')))), ''),
        h('div', { class: 'actions' }, ...actions, closeBtn(() => m)));
      const m = modal(r.number, body, { wide: true });
    } catch (e) { toastErr(e); }
  }

  async function substitutesDialog(rxId, item, done) {
    try {
      const { substitutes, reason } = await Api.get(`/api/dispensation/substitutes?${qs({ productId: item.product_id })}`);
      const body = h('div', {}, h('p', { class: 'muted' }, `Équivalents de « ${item.name} » : mêmes substances, même dosage, même forme. Le pharmacien reste responsable du choix ; les alertes sont recalculées après remplacement.`),
        table(['Produit', 'Type', 'Prix', 'Stock', ''], substitutes.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.name), h('div', { class: 'small muted' }, [s.dosage, s.form].filter(Boolean).join(' · '))), h('td', {}, s.isGeneric ? h('span', { class: 'badge ok' }, 'Générique') : 'Princeps'), h('td', { class: 'num' }, money(s.salePrice)),
          h('td', {}, s.available > 0 ? String(s.available) : h('span', { class: 'badge bad' }, 'Rupture')),
          h('td', {}, h('button', { class: 'btn sm primary', onclick: (e) => busy(e.currentTarget, async () => { try { const r = await Api.post(`/api/dispensation/prescriptions/${rxId}/items/${item.id}/substitute`, { productId: s.id }); m.close(); toast(r.alerts.some((a) => a.level !== 'info') ? 'Produit remplacé — des alertes sont à examiner' : 'Produit remplacé', r.alerts.some((a) => a.level === 'danger')); done(); } catch (x) { toastErr(x); } }) }, 'Remplacer')))), reason || 'Aucun équivalent en catalogue (mêmes substances, dosage et forme).'),
        h('div', { class: 'actions' }, closeBtn(() => m)));
      const m = modal('Substituts', body, { wide: true });
    } catch (e) { toastErr(e); }
  }

  async function labelsDialog(id) {
    try {
      const d = await Api.get(`/api/dispensation/prescriptions/${id}/labels`);
      const card = (l) => h('div', { class: 'label-card' }, h('div', { class: 'small muted' }, `${d.pharmacy || 'Pharmacie'} — ${d.number}`), h('strong', {}, d.patientName),
        h('div', {}, `${l.product}${l.dosage ? ' ' + l.dosage : ''}${l.form ? ' (' + l.form + ')' : ''} — Qté ${l.quantity}`), h('div', { class: 'poso' }, l.posology || 'Posologie : selon ordonnance'),
        h('div', { class: 'small muted' }, l.lots.length ? `Lot ${l.lots.map((x) => `${x.lotNumber} (exp. ${fmtDate(x.expiryDate)})`).join(', ')}` : 'Lot : attribué à la délivrance'), h('div', { class: 'small muted' }, `Prescrit le ${fmtDate(d.prescribedOn)}${d.dispensedAt ? ` · Délivré le ${fmtDate(d.dispensedAt)}` : ''}`));
      const body = h('div', {}, h('div', { class: 'labels-sheet' }, d.labels.map(card)), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => window.print() }, 'Imprimer'), closeBtn(() => m)));
      const m = modal(`Étiquettes — ${d.number}`, body, { wide: true }); m.box.classList.add('labels');
    } catch (e) { toastErr(e); }
  }

  window.ModuleKit = { can, money, debounce, qs, toastErr, kv, closeBtn, alertBox };
  window.ModuleViews = { ...(window.ModuleViews || {}), patients, stocks, dispensation };
})();
