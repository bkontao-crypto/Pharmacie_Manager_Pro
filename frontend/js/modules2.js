'use strict';
/** Vues Phase 3 : Achats & Fournisseurs, Ventes & Caisse, Rapports & Pilotage. */
(() => {
  const { h, toast, modal, field, fmtDate, fmtDateTime } = UI;
  const { can, money, debounce, qs, toastErr, kv, closeBtn } = ModuleKit;
  const todayStr = () => UI.today();
  const cents = (n) => Math.round(Number(n) * 100);
  const METHODS = { especes: 'Espèces', mobile_money: 'Mobile money', carte: 'Carte', tiers_payant: 'Tiers-payant' };
  const seg = (items, current, onPick) => h('div', { class: 'seg', role: 'group' }, items.map(([k, l]) => h('button', { class: `btn sm${k === current ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(k === current), onclick: () => onPick(k) }, l)));

  /** Champ de recherche + liste de résultats cliquables (produits). */
  function picker({ url, placeholder, label, row, onPick }) {
    const input = h('input', { class: 'search', type: 'search', placeholder, 'aria-label': label }); const list = h('div', { class: 'pick hidden' });
    input.addEventListener('input', debounce(async () => {
      if (!input.value.trim()) return list.classList.add('hidden');
      try { const { products } = await Api.get(`${url}?${qs({ q: input.value })}`);
        list.replaceChildren(...(products.length ? products.map((x) => { const [l, r] = row(x); return h('button', { type: 'button', onclick: () => { onPick(x); input.value = ''; list.classList.add('hidden'); } }, h('span', {}, l), h('span', { class: 'muted small' }, r)); }) : [h('div', { class: 'empty' }, 'Aucun produit trouvé')]));
        list.classList.remove('hidden'); } catch (e) { toastErr(e); } }));
    return { input, list };
  }

  /* ============================ ACHATS ============================ */
  const PO = { draft: ['Brouillon', ''], sent: ['Envoyée', 'warn'], partial: ['Reçue partiellement', 'warn'], received: ['Reçue', 'ok'], cancelled: ['Annulée', 'bad'] };
  const poBadge = (s) => h('span', { class: `badge ${PO[s][1]}` }, PO[s][0]);

  async function achats(content) {
    let tab = 'orders'; const holder = h('div'); const tabsBox = h('div', { class: 'toolbar' });
    async function show() {
      tabsBox.replaceChildren(seg([['orders', 'Commandes'], ['suggestions', 'Commande automatique'], ['suppliers', 'Fournisseurs']], tab, (k) => { tab = k; show(); }));
      holder.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Chargement…')));
      try { await ({ orders: ordersTab, suggestions: suggestionsTab, suppliers: suppliersTab })[tab](holder, show); } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    content.replaceChildren(pageHead('Achats & Fournisseurs', can('achats:write') && h('button', { class: 'btn primary', onclick: () => newOrderDialog(show) }, 'Nouvelle commande')), tabsBox, holder);
    await show();
  }

  async function ordersTab(holder, reload) {
    const status = h('select', { 'aria-label': 'Filtrer par statut' }, [['', 'Toutes les commandes'], ...Object.entries(PO).map(([k, [l]]) => [k, l])].map(([v, l]) => h('option', { value: v }, l)));
    const box = h('div', { class: 'card' });
    const load = async () => {
      const { orders } = await Api.get(`/api/achats/orders?${qs({ status: status.value })}`);
      box.replaceChildren(table(['N°', 'Fournisseur', 'Date', 'Statut', 'Reçu / commandé', 'Montant', ''], orders.map((o) => h('tr', {}, h('td', {}, h('strong', {}, o.number)), h('td', {}, o.supplierName), h('td', {}, fmtDate(o.createdAt)), h('td', {}, poBadge(o.status)),
        h('td', { class: 'num' }, `${o.qtyReceived} / ${o.qtyOrdered}`), h('td', { class: 'num' }, money(o.total)), h('td', {}, h('button', { class: 'btn sm', onclick: () => orderDetail(o.id, reload) }, 'Ouvrir')))), 'Aucune commande. Créez-en une, ou partez des suggestions automatiques.'));
    };
    status.addEventListener('change', () => load().catch(toastErr));
    holder.replaceChildren(h('div', { class: 'toolbar' }, status), box); await load();
  }

  async function suggestionsTab(holder, reload) {
    const [{ suggestions }, { suppliers }] = await Promise.all([Api.get('/api/achats/suggestions'), Api.get('/api/achats/suppliers')]);
    const active = suppliers.filter((s) => s.isActive);
    const sel = h('select', { 'aria-label': 'Fournisseur' }, active.map((s) => h('option', { value: s.id }, s.name)));
    const rows = suggestions.map((s) => ({ s, cb: h('input', { type: 'checkbox', checked: true, 'aria-label': `Inclure ${s.name}` }), qty: h('input', { class: 'qty', type: 'number', min: '1', step: '1', value: s.quantity, 'aria-label': `Quantité ${s.name}` }) }));
    const create = h('button', { class: 'btn primary', disabled: !active.length || !rows.length, onclick: (e) => busy(e.currentTarget, async () => {
      const items = rows.filter((r) => r.cb.checked).map((r) => ({ productId: r.s.id, quantity: parseInt(r.qty.value, 10), unitCost: r.s.unitCost }));
      if (!items.length) return toast('Cochez au moins une ligne', true);
      try { const r = await Api.post('/api/achats/orders', { supplierId: sel.value, items }); toast(`Brouillon ${r.number} créé — vérifiez puis envoyez-le`); reload(); } catch (x) { toastErr(x); } }) }, 'Créer un brouillon de commande');
    holder.replaceChildren(h('div', { class: 'info-box' }, 'Produits dont le stock disponible (+ déjà commandé) est au niveau du seuil d’alerte ou en dessous. La quantité proposée ramène le stock au seuil maximum (ou 2 × le seuil minimum). Modifiable avant création.'),
      h('div', { class: 'card' }, suggestions.length ? h('div', {}, table(['', 'Produit', 'Stock', 'Déjà commandé', 'Seuils min / max', 'Quantité à commander'], rows.map(({ s, cb, qty }) => h('tr', {}, h('td', {}, cb), h('td', {}, h('strong', {}, s.name), h('div', { class: 'small muted' }, s.dci || '')), h('td', { class: 'num' }, s.available), h('td', { class: 'num' }, s.onOrder), h('td', { class: 'num' }, `${s.minStock} / ${s.maxStock ?? '—'}`), h('td', {}, qty))), ''),
        can('achats:write') && h('div', { class: 'actions' }, active.length ? field('Fournisseur', sel) : h('span', { class: 'muted' }, 'Créez d’abord un fournisseur.'), create)) : h('div', { class: 'empty' }, 'Aucun produit à réapprovisionner. Renseignez des seuils d’alerte sur vos produits pour activer les suggestions.')));
  }

  async function suppliersTab(holder, reload) {
    const { suppliers } = await Api.get('/api/achats/suppliers');
    holder.replaceChildren(h('div', { class: 'toolbar' }, can('achats:write') && h('button', { class: 'btn', onclick: () => supplierForm(null, reload) }, 'Nouveau fournisseur')),
      h('div', { class: 'card' }, table(['Fournisseur', 'Contact', 'Téléphone', 'E-mail', 'Statut', ''], suppliers.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.name)), h('td', {}, s.contactName || '—'), h('td', {}, s.phone || '—'), h('td', {}, s.email || '—'),
        h('td', {}, h('span', { class: `badge ${s.isActive ? 'ok' : 'bad'}` }, s.isActive ? 'Actif' : 'Inactif')), h('td', {}, can('achats:write') && h('button', { class: 'btn sm', onclick: () => supplierForm(s, reload) }, 'Modifier')))), 'Aucun fournisseur. Ajoutez vos grossistes-répartiteurs.')));
  }

  function supplierForm(s, reload) {
    const err = errBox(); const f = { name: h('input', { type: 'text', required: true, value: s?.name || '' }), contact: h('input', { type: 'text', value: s?.contactName || '' }), phone: h('input', { type: 'tel', value: s?.phone || '' }), email: h('input', { type: 'email', value: s?.email || '' }), address: h('input', { type: 'text', value: s?.address || '' }), active: h('input', { type: 'checkbox', checked: s ? s.isActive : true }) };
    const save = h('button', { class: 'btn primary', type: 'submit' }, s ? 'Enregistrer' : 'Créer');
    const form = h('form', { novalidate: true }, err, field('Nom', f.name), h('div', { class: 'row' }, field('Contact', f.contact), field('Téléphone', f.phone)), field('E-mail', f.email), field('Adresse', f.address),
      s && h('label', { class: 'check-list' }, h('span', {}, f.active, ' Fournisseur actif')), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(s ? 'Modifier le fournisseur' : 'Nouveau fournisseur', form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      const body = { name: f.name.value, contactName: f.contact.value, phone: f.phone.value, email: f.email.value, address: f.address.value, ...(s ? { isActive: f.active.checked } : {}) };
      try { s ? await Api.patch(`/api/achats/suppliers/${s.id}`, body) : await Api.post('/api/achats/suppliers', body); m.close(); toast('Fournisseur enregistré'); reload(); } catch (x) { showErr(err, x); } }); };
  }

  async function newOrderDialog(reload) {
    let suppliers; try { ({ suppliers } = await Api.get('/api/achats/suppliers')); } catch (e) { return toastErr(e); }
    suppliers = suppliers.filter((s) => s.isActive);
    if (!suppliers.length) return toast('Créez d’abord un fournisseur (onglet Fournisseurs).', true);
    const err = errBox(); const sel = h('select', {}, suppliers.map((s) => h('option', { value: s.id }, s.name))); const items = new Map(); const body = h('tbody'); const notes = h('input', { type: 'text' });
    const renderItems = () => body.replaceChildren(...[...items.values()].map((it) => h('tr', {}, h('td', {}, h('strong', {}, it.p.name), h('div', { class: 'small muted' }, `Stock : ${it.p.available}`)), h('td', {}, it.qty), h('td', {}, it.cost), h('td', {}, h('button', { class: 'btn sm danger', type: 'button', onclick: () => { items.delete(it.p.id); renderItems(); } }, 'Retirer')))));
    const pk = picker({ url: '/api/achats/lookup/products', placeholder: 'Ajouter un produit (nom, DCI, code-barres)', label: 'Rechercher un produit', row: (x) => [`${x.name}${x.dosage ? ' ' + x.dosage : ''}`, `${x.available} en stock`], onPick: (x) => { if (!items.has(x.id)) items.set(x.id, { p: x, qty: h('input', { class: 'qty', type: 'number', min: '1', step: '1', value: '1', 'aria-label': `Quantité ${x.name}` }), cost: h('input', { class: 'qty', type: 'number', min: '0', step: '1', value: x.unitCost, 'aria-label': `Coût unitaire ${x.name}` }) }); renderItems(); } });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Créer le brouillon');
    const form = h('form', { novalidate: true }, err, field('Fournisseur', sel), h('strong', {}, 'Produits à commander'), pk.input, pk.list,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Produit', 'Quantité', 'Coût unitaire (FCFA)', ''].map((x) => h('th', { scope: 'col' }, x)))), body)), field('Notes', notes), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvelle commande', form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      if (!items.size) return showErr(err, new Error('Ajoutez au moins un produit'));
      try { const r = await Api.post('/api/achats/orders', { supplierId: sel.value, notes: notes.value, items: [...items.values()].map((it) => ({ productId: it.p.id, quantity: parseInt(it.qty.value, 10), unitCost: Number(it.cost.value) })) }); m.close(); toast(`Brouillon ${r.number} créé`); reload(); } catch (x) { showErr(err, x); } }); };
  }

  async function orderDetail(id, reload) {
    try {
      const { order: o, items } = await Api.get(`/api/achats/orders/${id}`);
      let invoices = []; if (['partial', 'received'].includes(o.status)) { try { ({ invoices } = await Api.get(`/api/achats/orders/${id}/invoices`)); } catch { invoices = []; } }
      const act = (label, cls, fn) => h('button', { class: `btn ${cls}`, onclick: (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (x) { toastErr(x); } }) }, label);
      const refresh = () => { m.close(); reload(); orderDetail(id, reload); };
      const actions = [];
      if (o.status === 'draft' && can('achats:approve')) actions.push(act('Envoyer au fournisseur', 'success', async () => { await Api.post(`/api/achats/orders/${id}/send`, {}); toast('Commande envoyée'); refresh(); }));
      if (['sent', 'partial'].includes(o.status) && can('achats:write')) actions.push(h('button', { class: 'btn primary', onclick: () => { m.close(); receiveDialog(o, items, () => { reload(); orderDetail(id, reload); }); } }, 'Réceptionner'));
      if (['partial', 'received'].includes(o.status) && can('achats:write')) actions.push(h('button', { class: 'btn', onclick: () => { m.close(); invoiceDialog(o, items, () => { reload(); orderDetail(id, reload); }); } }, 'Saisir la facture'));
      if (['draft', 'sent'].includes(o.status) && can('achats:write')) actions.push(act('Annuler la commande', 'danger', async () => { if (!confirm('Annuler cette commande ?')) return; await Api.post(`/api/achats/orders/${id}/cancel`, {}); toast('Commande annulée'); refresh(); }));
      const body = h('div', {}, h('p', {}, poBadge(o.status)), kv([['Fournisseur', o.supplierName], ['Créée le', fmtDateTime(o.createdAt)], ['Envoyée le', o.sentAt && fmtDateTime(o.sentAt)], ['Notes', o.notes]]),
        table(['Produit', 'Commandé', 'Reçu', 'Manquant', 'Coût unitaire'], items.map((i) => h('tr', {}, h('td', {}, h('strong', {}, i.name), h('div', { class: 'small muted' }, i.dci || '')), h('td', { class: 'num' }, i.quantityOrdered), h('td', { class: 'num' }, i.quantityReceived),
          h('td', { class: 'num' }, i.missing > 0 && ['sent', 'partial'].includes(o.status) ? h('span', { class: 'badge bad' }, i.missing) : i.missing), h('td', { class: 'num' }, money(i.unitCost)))), ''),
        invoices.length ? h('div', {}, h('strong', {}, 'Factures rapprochées'), table(['Facture', 'Date', 'Facturé', 'Attendu', 'Écart', 'Statut'], invoices.map((f) => h('tr', {}, h('td', {}, f.invoiceNumber), h('td', {}, fmtDate(f.invoiceDate)), h('td', { class: 'num' }, money(f.total)), h('td', { class: 'num' }, money(f.expectedTotal)),
          h('td', { class: 'num' }, f.gapAmount === 0 ? '—' : h('span', { class: 'badge bad' }, `${f.gapAmount > 0 ? '+' : ''}${money(f.gapAmount)}`)), h('td', {}, f.status === 'conforme' ? h('span', { class: 'badge ok' }, 'Conforme') : h('span', { class: 'badge bad' }, 'Écart', f.gaps.length ? ` (${f.gaps.map((g) => `${g.name} : ${g.qtyGap ? `${g.qtyGap > 0 ? '+' : ''}${g.qtyGap} u.` : ''}${g.qtyGap && g.priceGap ? ', ' : ''}${g.priceGap ? `prix ${g.priceGap > 0 ? '+' : ''}${g.priceGap}` : ''}`).join(' ; ')})` : '')))), '')) : null,
        h('p', { class: 'num' }, h('strong', {}, `Montant commandé : ${money(o.total)}`)), h('div', { class: 'actions' }, ...actions, closeBtn(() => m)));
      const m = modal(o.number, body, { wide: true });
    } catch (e) { toastErr(e); }
  }

  function receiveDialog(o, items, done) {
    const err = errBox(); const open = items.filter((i) => i.missing > 0);
    const rows = open.map((i) => ({ i, qty: h('input', { class: 'qty', type: 'number', min: '0', max: String(i.missing), step: '1', value: i.missing, 'aria-label': `Quantité reçue ${i.name}` }), lot: h('input', { class: 'qty', type: 'text', 'aria-label': `Lot ${i.name}` }), exp: h('input', { type: 'date', 'aria-label': `Péremption ${i.name}` }) }));
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Valider la réception');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, 'Saisissez ce qui a réellement été livré. Mettez 0 pour une ligne non livrée : elle restera en manquant et la commande en réception partielle.'),
      table(['Produit', 'Manquant', 'Reçu', 'N° de lot', 'Péremption'], rows.map(({ i, qty, lot, exp }) => h('tr', {}, h('td', {}, h('strong', {}, i.name)), h('td', { class: 'num' }, i.missing), h('td', {}, qty), h('td', {}, lot), h('td', {}, exp))), ''), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(`Réception ${o.number}`, form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      const lines = []; for (const r of rows) { const q = parseInt(r.qty.value, 10) || 0; if (q <= 0) continue; if (!r.lot.value.trim() || !r.exp.value) return showErr(err, new Error(`« ${r.i.name} » : n° de lot et péremption requis`)); lines.push({ itemId: r.i.id, quantity: q, lotNumber: r.lot.value, expiryDate: r.exp.value }); }
      if (!lines.length) return showErr(err, new Error('Aucune quantité reçue'));
      try { const r = await Api.post(`/api/achats/orders/${o.id}/receive`, { lines }); m.close(); toast(r.missing ? `Réception partielle : ${r.missing} unité(s) encore manquante(s)` : 'Commande entièrement reçue, stock mis à jour'); done(); } catch (x) { showErr(err, x); } }); };
  }

  function invoiceDialog(o, items, done) {
    const err = errBox(); const received = items.filter((i) => i.quantityReceived > 0);
    if (!received.length) return toast('Aucune ligne reçue : rien à rapprocher.', true);
    const num = h('input', { type: 'text', required: true }); const date = h('input', { type: 'date', required: true, value: todayStr() });
    const rows = received.map((i) => ({ i, qty: h('input', { class: 'qty', type: 'number', min: '0', step: '1', value: i.quantityReceived, 'aria-label': `Quantité facturée ${i.name}` }), price: h('input', { class: 'qty', type: 'number', min: '0', step: '0.01', value: i.unitCost, 'aria-label': `Prix unitaire facturé ${i.name}` }) }));
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Rapprocher la facture');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, 'Saisissez la facture telle que reçue : elle est comparée aux quantités réellement reçues et aux prix de la commande.'), h('div', { class: 'row' }, field('N° de facture', num), field('Date de facture', date)),
      table(['Produit', 'Reçu', 'Prix commandé', 'Qté facturée', 'Prix facturé'], rows.map(({ i, qty, price }) => h('tr', {}, h('td', {}, h('strong', {}, i.name)), h('td', { class: 'num' }, i.quantityReceived), h('td', { class: 'num' }, money(i.unitCost)), h('td', {}, qty), h('td', {}, price))), ''),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal(`Facture — ${o.number}`, form, { wide: true });
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      try {
        const r = await Api.post(`/api/achats/orders/${o.id}/invoices`, { invoiceNumber: num.value, invoiceDate: date.value, lines: rows.map(({ i, qty, price }) => ({ itemId: i.id, quantity: parseInt(qty.value, 10) || 0, unitPrice: Number(price.value) })) });
        m.close();
        if (r.status === 'conforme') toast('Facture conforme à la commande et à la réception');
        else { const box = h('div', {}, h('div', { class: r.gapAmount > 0 ? 'alert-box' : 'info-box' }, h('strong', {}, r.gapAmount > 0 ? `On vous facture ${money(r.gapAmount)} de plus que prévu.` : r.gapAmount < 0 ? `On vous facture ${money(-r.gapAmount)} de moins que prévu.` : 'Écarts de quantité/prix qui se compensent.'), h('div', { class: 'small' }, `Facturé ${money(r.total)} — attendu ${money(r.expectedTotal)}`)),
          table(['Produit', 'Écart quantité', 'Écart prix unitaire', 'Impact'], r.lines.map((l) => h('tr', {}, h('td', {}, l.name), h('td', { class: 'num' }, l.qtyGap), h('td', { class: 'num' }, money(l.priceGap)), h('td', { class: 'num' }, money(l.impact)))), ''), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => mm.close() }, 'Compris'))); const mm = modal('Écarts de facturation', box, { wide: true }); }
        done();
      } catch (x) { showErr(err, x); } }); };
  }

  /* ============================ VENTES & CAISSE ============================ */
  async function ventes(content) {
    const day = h('input', { type: 'date', value: todayStr(), 'aria-label': 'Date des ventes' }); const statsBox = h('div', { class: 'stats' }); const holder = h('div', { class: 'card' });
    async function load() {
      try {
        const { sales } = await Api.get(`/api/ventes/sales?${qs({ date: day.value })}`); const paid = sales.filter((s) => s.status === 'paid');
        statsBox.replaceChildren(stat(paid.length, 'Ventes encaissées', 'green'), stat(money(paid.reduce((t, s) => t + s.total, 0)), 'Chiffre d’affaires du jour'), stat(sales.length - paid.length, 'Remboursées', sales.length - paid.length ? 'warn' : ''));
        holder.replaceChildren(table(['N°', 'Heure', 'Client / ordonnance', 'Total', 'Statut', 'Opérateur', ''], sales.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.number)), h('td', {}, fmtDateTime(s.createdAt).slice(-5)), h('td', {}, s.prescriptionNumber ? `Ordonnance ${s.prescriptionNumber}` : s.patientName || 'Vente comptoir'), h('td', { class: 'num' }, money(s.total)),
          h('td', {}, h('span', { class: `badge ${s.status === 'paid' ? 'ok' : 'bad'}` }, s.status === 'paid' ? 'Encaissée' : 'Remboursée')), h('td', { class: 'small muted' }, s.userEmail || '—'), h('td', {}, h('button', { class: 'btn sm', onclick: () => saleDetail(s.id, load) }, 'Ticket')))), 'Aucune vente à cette date.'));
      } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    day.addEventListener('change', load);
    content.replaceChildren(pageHead('Ventes & Caisse', can('ventes:write') && h('button', { class: 'btn primary', onclick: () => posDialog(load) }, 'Nouvelle vente')), statsBox, h('div', { class: 'toolbar' }, field('Jour', day)), holder);
    await load();
  }

  async function posDialog(reload) {
    const err = errBox(); let mode = 'counter'; const cart = new Map(); let billable = []; let rxSel = null; let patient = null; let loyalty = { enabled: false, pointValue: 0, earnAmount: 1000 };
    const points = h('input', { type: 'number', min: '0', step: '1', value: '0', 'aria-label': 'Points utilisés' }); const patientBox = h('div');
    try { ({ prescriptions: billable } = await Api.get('/api/ventes/billable-prescriptions')); } catch { billable = []; }
    const modeBox = h('div'); const zone = h('div'); const discount = h('input', { type: 'number', min: '0', max: '100', step: '1', value: '0', 'aria-label': 'Remise en pourcent' });
    const totalsBox = h('div', { class: 'totals' }); const payBox = h('div'); const payRows = []; const tendered = h('input', { type: 'number', min: '0', step: '1', placeholder: 'Montant remis', 'aria-label': 'Espèces remises par le client' }); const save = h('button', { class: 'btn success', type: 'submit', disabled: true }, 'Encaisser');
    const cartBody = h('tbody');
    const compute = () => {
      const pct = Math.min(100, Math.max(0, Number(discount.value) || 0));
      const sub = mode === 'rx' ? (rxSel ? cents(rxSel.total) : 0) : [...cart.values()].reduce((t, c) => t + cents(c.p.unitPrice) * (parseInt(c.qty.value, 10) || 0), 0);
      const disc = Math.round(sub * pct / 100); const net = sub - disc;
      const usable = mode === 'counter' && patient && loyalty.enabled && patient.points > 0 && cents(loyalty.pointValue) > 0 ? Math.max(0, Math.min(patient.points, Math.floor((net - 1) / cents(loyalty.pointValue)))) : 0;   // la vente doit rester payable
      const used = Math.min(usable, Math.max(0, parseInt(points.value, 10) || 0)); const redeem = used * cents(loyalty.pointValue);
      return { sub, disc, used, usable, redeem, total: net - redeem, earn: mode === 'counter' && patient && loyalty.enabled ? Math.floor((net - redeem) / cents(loyalty.earnAmount)) : 0 };
    };
    const paid = () => payRows.reduce((t, r) => t + cents(r.amount.value || 0), 0);
    const refreshTotals = () => {
      const { sub, disc, used, redeem, earn, total } = compute(); const rest = total - paid(); const cash = payRows.filter((r) => r.method.value === 'especes').reduce((t, r) => t + cents(r.amount.value || 0), 0);
      const change = cents(tendered.value || 0) - cash;
      totalsBox.replaceChildren(...[h('span', {}, 'Sous-total'), h('span', { class: 'num' }, money(sub / 100)), h('span', {}, 'Remise'), h('span', { class: 'num' }, `− ${money(disc / 100)}`), used > 0 ? h('span', {}, `Points utilisés (${used})`) : null, used > 0 ? h('span', { class: 'num' }, `− ${money(redeem / 100)}`) : null, h('span', { class: 'big' }, 'Total à payer'), h('span', { class: 'big num' }, money(total / 100)),
        h('span', {}, 'Reste à encaisser'), h('span', { class: `num ${rest === 0 && total > 0 ? 'ok' : 'bad'}` }, money(rest / 100)), cash > 0 && tendered.value ? h('span', {}, 'Monnaie à rendre') : null, cash > 0 && tendered.value ? h('span', { class: `num ${change >= 0 ? 'ok' : 'bad'}` }, change >= 0 ? money(change / 100) : 'Montant remis insuffisant') : null].filter(Boolean));
      if (earn > 0) totalsBox.append(h('span', { class: 'muted small' }, 'Points qui seront gagnés'), h('span', { class: 'num muted small' }, `+ ${earn}`));
      save.disabled = !(total > 0 && rest === 0);
    };
    const addPay = (amount = '') => { const r = { method: h('select', { 'aria-label': 'Moyen de paiement' }, Object.entries(METHODS).map(([k, l]) => h('option', { value: k }, l))), amount: h('input', { type: 'number', min: '0', step: '1', value: amount, 'aria-label': 'Montant payé' }) };
      r.el = h('div', { class: 'pay-row' }, r.method, r.amount, h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Retirer ce paiement', onclick: () => { payRows.splice(payRows.indexOf(r), 1); r.el.remove(); refreshTotals(); } }, '×'));
      r.method.addEventListener('change', refreshTotals); r.amount.addEventListener('input', refreshTotals); payRows.push(r); payBox.append(r.el); };
    const renderCart = () => { cartBody.replaceChildren(...[...cart.values()].map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.p.name), h('div', { class: 'small muted' }, `${money(c.p.unitPrice)} · ${c.p.available} en stock`)), h('td', {}, c.qty), h('td', { class: 'num' }, money(c.p.unitPrice * (parseInt(c.qty.value, 10) || 0))), h('td', {}, h('button', { class: 'btn sm danger', type: 'button', onclick: () => { cart.delete(c.p.id); renderCart(); refreshTotals(); } }, 'Retirer'))))); };
    const pk = picker({ url: '/api/ventes/lookup/products', placeholder: 'Rechercher un produit ou scanner un code-barres', label: 'Rechercher un produit', row: (x) => [`${x.name}${x.dosage ? ' ' + x.dosage : ''}`, x.requiresPrescription ? 'Sur ordonnance' : `${money(x.unitPrice)} · ${x.available} en stock`],
      onPick: (x) => { if (x.requiresPrescription) return toast(`« ${x.name} » est délivré sur ordonnance : utilisez la dispensation.`, true); if (!x.available) return toast(`« ${x.name} » est en rupture.`, true);
        if (!cart.has(x.id)) { const qty = h('input', { class: 'qty', type: 'number', min: '1', max: String(x.available), step: '1', value: '1', 'aria-label': `Quantité ${x.name}` }); qty.addEventListener('input', () => { renderCart(); refreshTotals(); }); cart.set(x.id, { p: x, qty }); } renderCart(); refreshTotals(); } });
    const drawPatient = () => {
      if (mode !== 'counter') return patientBox.replaceChildren();
      if (patient) return patientBox.replaceChildren(h('div', { class: 'info-box' }, h('strong', {}, patient.name), loyalty.enabled ? ` — ${patient.points} point(s)` : '', ' ',
        h('button', { class: 'btn sm', type: 'button', onclick: () => { patient = null; points.value = '0'; drawPatient(); refreshTotals(); } }, 'Changer'),
        loyalty.enabled && patient.points > 0 ? h('div', { class: 'row' }, field('Points à utiliser', points, `Valeur d’un point : ${money(loyalty.pointValue)}`)) : null));
      const q = h('input', { class: 'search', type: 'search', placeholder: 'Client fidélité (optionnel) : nom ou téléphone', 'aria-label': 'Rechercher un client' }); const list = h('div', { class: 'pick hidden' });
      q.addEventListener('input', debounce(async () => {
        if (!q.value.trim()) return list.classList.add('hidden');
        try { const r = await Api.get(`/api/ventes/lookup/patients?${qs({ q: q.value })}`); loyalty = r.loyalty;
          list.replaceChildren(...(r.patients.length ? r.patients.map((x) => h('button', { type: 'button', onclick: () => { patient = x; points.value = '0'; drawPatient(); refreshTotals(); } }, h('span', {}, x.name), h('span', { class: 'muted small' }, x.points == null ? '' : `${x.points} pt`))) : [h('div', { class: 'empty' }, 'Aucun client trouvé')]));
          list.classList.remove('hidden'); } catch (x) { toastErr(x); } }));
      patientBox.replaceChildren(q, list);
    };
    points.addEventListener('input', refreshTotals);
    const drawZone = () => {
      modeBox.replaceChildren(seg([['counter', 'Vente comptoir'], ['rx', 'Ordonnance délivrée']], mode, (k) => { mode = k; drawZone(); drawPatient(); refreshTotals(); }));
      if (mode === 'counter') zone.replaceChildren(pk.input, pk.list, h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Produit', 'Quantité', 'Montant', ''].map((x) => h('th', { scope: 'col' }, x)))), cartBody)));
      else { const sel = h('select', { 'aria-label': 'Ordonnance à facturer' }, [h('option', { value: '' }, billable.length ? 'Choisir une ordonnance…' : 'Aucune ordonnance à facturer'), ...billable.map((b) => h('option', { value: b.id }, `${b.number} — ${b.patientName} — ${money(b.total)}`))]);
        sel.addEventListener('change', () => { rxSel = billable.find((b) => b.id === sel.value) || null; refreshTotals(); }); zone.replaceChildren(h('p', { class: 'muted' }, 'Le stock a déjà été sorti à la dispensation : la facturation n’y touche pas.'), field('Ordonnance', sel)); }
    };
    discount.addEventListener('input', refreshTotals); tendered.addEventListener('input', refreshTotals);
    const form = h('form', { novalidate: true }, err, modeBox, zone, patientBox, h('div', { class: 'row' }, field('Remise (%)', discount)), totalsBox, h('strong', {}, 'Paiement'), payBox,
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => addPay('') }, 'Ajouter un moyen de paiement'), h('button', { class: 'btn sm', type: 'button', onclick: () => { const { total } = compute(); const rest = total - paid(); if (rest > 0) { const last = payRows[payRows.length - 1]; if (last && !last.amount.value) { last.amount.value = rest / 100; } else addPay(rest / 100); } refreshTotals(); } }, 'Payer le solde')),
      h('div', { class: 'field' }, h('label', {}, 'Espèces remises (pour calculer la monnaie)'), tendered),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvelle vente', form, { wide: true }); drawZone(); drawPatient(); addPay(''); refreshTotals();
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
      const body = { discountPct: Math.min(100, Math.max(0, Number(discount.value) || 0)), payments: payRows.filter((r) => Number(r.amount.value) > 0).map((r) => ({ method: r.method.value, amount: Number(r.amount.value) })) };
      if (mode === 'rx') { if (!rxSel) return showErr(err, new Error('Choisissez une ordonnance')); body.prescriptionId = rxSel.id; } else { if (!cart.size) return showErr(err, new Error('Ajoutez au moins un produit')); if (patient) { body.patientId = patient.id; const u = compute().used; if (u > 0) body.redeemPoints = u; } body.items = [...cart.values()].map((c) => ({ productId: c.p.id, quantity: parseInt(c.qty.value, 10) })); }
      try { const r = await Api.post('/api/ventes/sales', body); m.close(); toast(`Vente ${r.number} encaissée${r.earnedPoints ? ` — +${r.earnedPoints} point(s) fidélité` : ''}`); reload(); saleDetail(r.id, reload); } catch (x) { showErr(err, x); } }); };
  }

  async function saleDetail(id, reload) {
    try {
      const { sale: s, items, payments } = await Api.get(`/api/ventes/sales/${id}`);
      const refund = h('button', { class: 'btn danger', onclick: (e) => busy(e.currentTarget, async () => { const reason = prompt('Motif du retour / remboursement :'); if (!reason) return; try { await Api.post(`/api/ventes/sales/${id}/refund`, { reason }); toast('Vente remboursée, stock remis'); m.close(); reload(); } catch (x) { toastErr(x); } }) }, 'Rembourser');
      const body = h('div', {}, h('div', { class: 'receipt-head' }, h('strong', {}, me.tenantName || 'Pharmacie'), h('div', { class: 'small muted' }, `${s.number} — ${fmtDateTime(s.createdAt)}`), h('div', { class: 'small muted' }, `Servi par ${s.userEmail || '—'}`), s.prescriptionNumber && h('div', { class: 'small' }, `Ordonnance ${s.prescriptionNumber}`), s.status === 'refunded' && h('div', {}, h('span', { class: 'badge bad' }, `Remboursée : ${s.refundReason}`))),
        table(['Produit', 'Qté', 'PU', 'Montant'], items.map((i) => h('tr', {}, h('td', {}, `${i.name}${i.dosage ? ' ' + i.dosage : ''}`), h('td', { class: 'num' }, i.quantity), h('td', { class: 'num' }, money(i.unitPrice)), h('td', { class: 'num' }, money(i.unitPrice * i.quantity)))), ''),
        h('div', { class: 'totals' }, h('span', {}, 'Sous-total'), h('span', { class: 'num' }, money(s.subtotal)), s.discountAmount > 0 && h('span', {}, `Remise ${s.discountPct}%`), s.discountAmount > 0 && h('span', { class: 'num' }, `− ${money(s.discountAmount)}`), s.redeemedPoints > 0 && h('span', {}, `Points utilisés (${s.redeemedPoints})`), s.redeemedPoints > 0 && h('span', { class: 'num' }, `− ${money(s.redeemAmount)}`), h('span', { class: 'big' }, 'Total'), h('span', { class: 'big num' }, money(s.total)), ...payments.flatMap((p) => [h('span', {}, METHODS[p.method]), h('span', { class: 'num' }, money(p.amount))])),
        h('div', { class: 'actions' }, s.status === 'paid' && !s.prescriptionNumber && can('ventes:refund') && refund, h('button', { class: 'btn', onclick: () => window.print() }, 'Imprimer'), closeBtn(() => m)));
      const m = modal(`Ticket ${s.number}`, body); m.box.classList.add('receipt');
    } catch (e) { toastErr(e); }
  }

  /* ============================ RAPPORTS ============================ */
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); kids.forEach((k) => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
  const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n)));

  function barChart(days) {
    const W = 720; const H = 230; const L = 46; const B = 28; const T = 10; const max = Math.max(1, ...days.map((d) => d.revenue)); const plotH = H - B - T; const bw = (W - L) / Math.max(days.length, 1);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Chiffre d’affaires par jour' }, svg('title', {}, 'Chiffre d’affaires par jour'));
    [0, .5, 1].forEach((f) => { const y = T + plotH * (1 - f); s.append(svg('line', { x1: L, x2: W, y1: y, y2: y, class: 'grid' }), svg('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' }, compact(max * f))); });
    days.forEach((d, i) => { const bh = (d.revenue / max) * plotH; s.append(svg('rect', { x: L + i * bw + bw * .15, y: T + plotH - bh, width: Math.max(bw * .7, 1), height: bh, rx: 2, class: 'col' }, svg('title', {}, `${fmtDate(d.day)} : ${money(d.revenue)} (${d.count} vente(s))`))); });
    [0, Math.floor((days.length - 1) / 2), days.length - 1].filter((v, i, a) => days.length && a.indexOf(v) === i).forEach((i) => s.append(svg('text', { x: L + i * bw + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis' }, fmtDate(days[i].day).slice(0, 5))));
    return s;
  }

  async function rapports(content) {
    const iso = (d) => UI.today(d); const now = new Date();
    const from = h('input', { type: 'date', value: iso(new Date(now - 29 * 864e5)), 'aria-label': 'Début de période' }); const to = h('input', { type: 'date', value: iso(now), 'aria-label': 'Fin de période' }); const body = h('div', { class: 'report-print' });
    const preset = (days) => { to.value = iso(now); from.value = iso(new Date(now - (days - 1) * 864e5)); load(); };
    async function load() {
      try {
        const r = await Api.get(`/api/rapports/overview?${qs({ from: from.value, to: to.value })}`); const k = r.kpis;
        body.replaceChildren(
          h('h2', { class: 'print-only' }, `Rapport du ${r.period.from} au ${r.period.to}`),
          h('div', { class: 'stats' }, stat(money(k.revenue), 'Chiffre d’affaires', 'green'), stat(k.salesCount, 'Ventes'), stat(money(k.avgBasket), 'Panier moyen'), stat(money(k.margin), `Marge brute · ${k.marginPct.toLocaleString('fr-FR')} %`)),
          h('div', { class: 'stats' }, stat(money(k.discounts), 'Remises accordées'), stat(money(k.refunded), 'Remboursements', k.refunded ? 'warn' : ''), stat(k.distinctPatients, 'Patients distincts servis'), stat(money(r.stockValuation.value), 'Valeur du stock (prix d’achat)'), r.stockValuation.expiredValue > 0 ? stat(money(r.stockValuation.expiredValue), 'Stock périmé à sortir', 'red') : null),
          h('div', { class: 'card' }, h('h2', {}, 'Chiffre d’affaires par jour'), r.byDay.length ? barChart(r.byDay) : h('div', { class: 'empty' }, 'Aucune vente sur cette période.')), h('br'),
          h('div', { class: 'grid-2' },
            h('div', { class: 'card' }, h('h2', {}, 'Top produits'), table(['Produit', 'Qté', 'CA', 'Marge'], r.topProducts.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'num' }, t.quantity), h('td', { class: 'num' }, money(t.revenue)), h('td', { class: 'num' }, money(t.margin)))), 'Aucune donnée.')),
            h('div', { class: 'card' }, h('h2', {}, 'Moyens de paiement'), table(['Moyen', 'Montant'], r.byMethod.map((m) => h('tr', {}, h('td', {}, METHODS[m.method] || m.method), h('td', { class: 'num' }, money(m.amount)))), 'Aucune donnée.'), h('br'), h('h2', {}, 'Par opérateur'), table(['Opérateur', 'Ventes', 'CA'], r.byOperator.map((o) => h('tr', {}, h('td', {}, o.name || o.email), h('td', { class: 'num' }, o.count), h('td', { class: 'num' }, money(o.revenue)))), 'Aucune donnée.'))));
      } catch (e) { body.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    const dl = (label, run) => h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { try { await run(); } catch (x) { toastErr(x); } }) }, label);
    const exp = h('span', { class: 'actions' },
      can('rapports:export') && dl('Exporter (Excel)', () => Api.download(`/api/rapports/export/report.xlsx?${qs({ from: from.value, to: to.value })}`, `rapport_${from.value}_${to.value}.xlsx`)),
      can('rapports:export') && dl('Ventes (CSV)', () => Api.download(`/api/rapports/export/sales.csv?${qs({ from: from.value, to: to.value })}`, `ventes_${from.value}_${to.value}.csv`)),
      h('button', { class: 'btn', onclick: () => window.print() }, 'Imprimer / PDF'));
    content.replaceChildren(pageHead('Rapports & Pilotage', exp), h('div', { class: 'toolbar' }, field('Du', from), field('Au', to), h('button', { class: 'btn primary', onclick: load }, 'Afficher'), seg([['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours']], '', (k) => preset(Number(k)))), body);
    await load();
  }

  window.ModuleViews = { ...(window.ModuleViews || {}), achats, ventes, rapports };
})();
