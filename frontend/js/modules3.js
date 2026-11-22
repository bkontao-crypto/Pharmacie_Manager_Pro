'use strict';
/** Vues Phase 4 : Intégrations (base de référence clinique) et Conformité & Traçabilité. */
(() => {
  const { h, toast, modal, field, fmtDate, fmtDateTime } = UI;
  const { can, debounce, qs, toastErr } = ModuleKit;
  const todayStr = () => UI.today();
  const seg = (items, current, onPick) => h('div', { class: 'seg', role: 'group' }, items.map(([k, l]) => h('button', { class: `btn sm${k === current ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(k === current), onclick: () => onPick(k) }, l)));
  const SEV = { contre_indication: ['Contre-indication', 'bad'], association_deconseillee: ['Association déconseillée', 'bad'], precaution: ['Précaution d’emploi', 'warn'], a_prendre_en_compte: ['À prendre en compte', ''] };

  /* ============================ INTÉGRATIONS ============================ */
  async function integrations(content) {
    let tab = 'rules'; const banner = h('div'); const holder = h('div'); const tabs = h('div', { class: 'toolbar' });
    async function loadBanner() {
      try {
        const st = await Api.get('/api/integrations/status'); const total = st.rules.global + st.rules.pharmacy;
        banner.replaceChildren(...[total === 0
          ? h('div', { class: 'alert-box warn', role: 'alert' }, h('strong', {}, 'Aucune base d’interactions chargée.'), h('div', {}, 'Tant qu’aucune base n’est importée, seules les allergies sont contrôlées (correspondance de noms). Importez une base médicamenteuse reconnue ci-dessous ou demandez au Superadmin de charger la base globale.'))
          : h('div', { class: 'info-box' }, `${st.rules.global} règle(s) globale(s) + ${st.rules.pharmacy} propre(s) à la pharmacie ; ${st.classes.global + st.classes.pharmacy} classe(s). Sources : ${st.sources.join(' · ') || '—'}. Ces données aident le pharmacien, elles ne remplacent pas son analyse.`),
          st.productsWithoutDci ? h('div', { class: 'info-box' }, `${st.productsWithoutDci} produit(s) actif(s) sans DCI : leurs interactions et allergies ne peuvent pas être contrôlées. Renseignez la DCI dans « Stocks ».`) : null].filter(Boolean));
      } catch (e) { banner.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    async function show() {
      tabs.replaceChildren(seg([['rules', 'Interactions'], ['classes', 'Classes thérapeutiques'], ['import', 'Importer']], tab, (k) => { tab = k; show(); }));
      holder.replaceChildren(); try { await ({ rules: rulesTab, classes: classesTab, import: importTab })[tab](holder, () => { loadBanner(); show(); }); } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    }
    content.replaceChildren(pageHead('Intégrations — base de référence clinique'), banner, tabs, holder); await loadBanner(); await show();
  }

  async function rulesTab(holder, reload) {
    const q = h('input', { class: 'search', type: 'search', placeholder: 'Substance ou classe', 'aria-label': 'Rechercher une règle' }); const box = h('div', { class: 'card' });
    const load = async () => {
      const { rules } = await Api.get(`/api/integrations/interactions?${qs({ q: q.value })}`);
      box.replaceChildren(table(['Termes', 'Gravité', 'Description / conduite', 'Portée', ''], rules.map((r) => h('tr', {}, h('td', {}, h('strong', {}, `${r.termA} + ${r.termB}`)), h('td', {}, h('span', { class: `badge ${SEV[r.severity][1]}` }, SEV[r.severity][0])),
        h('td', {}, r.description, r.recommendation && h('div', { class: 'small muted' }, `Conduite : ${r.recommendation}`)), h('td', { class: 'small' }, r.scope === 'globale' ? 'Globale' : 'Pharmacie', h('div', { class: 'muted' }, r.source)),
        h('td', {}, r.scope === 'pharmacie' && can('integrations:write') && h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Supprimer cette règle ?')) return; try { await Api.del(`/api/integrations/interactions/${r.id}`); toast('Règle supprimée'); reload(); } catch (x) { toastErr(x); } } }, 'Supprimer')))), q.value ? 'Aucune règle ne correspond.' : 'Aucune règle. Importez une base ou ajoutez vos règles.'));
    };
    q.addEventListener('input', debounce(() => load().catch(toastErr)));
    holder.replaceChildren(h('div', { class: 'toolbar' }, q, can('integrations:write') && h('button', { class: 'btn primary', onclick: () => ruleForm(reload) }, 'Ajouter une règle')), box); await load();
  }

  function ruleForm(reload) {
    const err = errBox(); const a = h('input', { type: 'text', required: true, placeholder: 'ex. warfarine' }); const b = h('input', { type: 'text', required: true, placeholder: 'ex. ains (substance ou classe)' });
    const sev = h('select', {}, Object.entries(SEV).map(([k, [l]]) => h('option', { value: k }, l))); const d = h('input', { type: 'text', required: true, placeholder: 'ex. risque hémorragique' }); const rec = h('input', { type: 'text', placeholder: 'ex. Avis du prescripteur' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter');
    const form = h('form', { novalidate: true }, err, h('p', { class: 'muted' }, 'Un terme peut être une substance (DCI) ou une classe définie dans « Classes thérapeutiques ». Les contre-indications et associations déconseillées exigent une justification écrite du pharmacien pour être validées.'),
      h('div', { class: 'row' }, field('Terme A', a), field('Terme B', b)), field('Gravité', sev), field('Description', d), field('Conduite à tenir', rec), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
    const m = modal('Nouvelle règle d’interaction', form);
    form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { try { await Api.post('/api/integrations/interactions', { termA: a.value, termB: b.value, severity: sev.value, description: d.value, recommendation: rec.value }); m.close(); toast('Règle ajoutée'); reload(); } catch (x) { showErr(err, x); } }); };
  }

  async function classesTab(holder, reload) {
    const q = h('input', { class: 'search', type: 'search', placeholder: 'Substance ou classe', 'aria-label': 'Rechercher une classe' }); const box = h('div', { class: 'card' });
    const load = async () => {
      const { classes } = await Api.get(`/api/integrations/classes?${qs({ q: q.value })}`);
      box.replaceChildren(table(['Classe', 'Substance', 'Portée', ''], classes.map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.class)), h('td', {}, c.substance), h('td', { class: 'small' }, c.scope === 'globale' ? 'Globale' : 'Pharmacie'),
        h('td', {}, c.scope === 'pharmacie' && can('integrations:write') && h('button', { class: 'btn sm danger', onclick: async () => { try { await Api.del(`/api/integrations/classes/${c.id}`); toast('Classe supprimée'); reload(); } catch (x) { toastErr(x); } } }, 'Supprimer')))),
        'Aucune classe. Elles permettent de relier une allergie « pénicillines » à l’amoxicilline, ou « AINS » à l’ibuprofène.'));
    };
    q.addEventListener('input', debounce(() => load().catch(toastErr)));
    const add = () => { const err = errBox(); const s = h('input', { type: 'text', required: true, placeholder: 'ex. ibuprofène' }); const c = h('input', { type: 'text', required: true, placeholder: 'ex. AINS' }); const save = h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter');
      const form = h('form', { novalidate: true }, err, field('Substance (DCI)', s), field('Classe', c), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save)); const m = modal('Nouvelle appartenance à une classe', form);
      form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => { try { await Api.post('/api/integrations/classes', { substance: s.value, class: c.value }); m.close(); reload(); } catch (x) { showErr(err, x); } }); }; };
    holder.replaceChildren(h('div', { class: 'toolbar' }, q, can('integrations:write') && h('button', { class: 'btn primary', onclick: add }, 'Ajouter')), box); await load();
  }

  async function importTab(holder, reload) {
    if (!can('integrations:write')) return holder.replaceChildren(h('div', { class: 'card empty' }, 'Vous n’avez pas le droit d’importer.'));
    const err = errBox(); const file = h('input', { type: 'file', accept: '.csv,.json,text/csv,application/json', 'aria-label': 'Fichier à importer' }); const kind = h('select', {}, [['interactions', 'CSV = interactions'], ['classes', 'CSV = classes']].map(([v, l]) => h('option', { value: v }, l)));
    const source = h('input', { type: 'text', placeholder: 'Origine et version de la base (obligatoire pour un CSV)' }); const result = h('div'); const go = h('button', { class: 'btn primary', type: 'submit' }, 'Importer');
    const form = h('form', { class: 'card', novalidate: true }, err, h('h2', {}, 'Importer une base'), h('br'),
      h('p', { class: 'muted' }, 'JSON : { "source": "…", "classes": [{substance, class}], "rules": [{termA, termB, severity, description, recommendation}] }. CSV interactions : colonnes terme_a;terme_b;gravite;description;recommandation. CSV classes : substance;classe. Gravités : contre_indication, association_deconseillee, precaution, a_prendre_en_compte.'),
      h('div', { class: 'info-box' }, 'Importez uniquement des données issues d’une source reconnue et dont vous avez le droit d’usage. Chaque import est tracé dans le journal d’audit.'), field('Fichier (.json ou .csv)', file), h('div', { class: 'row' }, field('Type (CSV)', kind), field('Source', source)), go);
    form.onsubmit = (e) => { e.preventDefault(); busy(go, async () => {
      const f = file.files[0]; if (!f) return showErr(err, new Error('Choisissez un fichier'));
      try {
        const text = await f.text(); let body;
        if (f.name.toLowerCase().endsWith('.json')) { const j = JSON.parse(text); body = { format: 'json', rules: j.rules || [], classes: j.classes || [], source: j.source || source.value }; }
        else { if (source.value.trim().length < 3) return showErr(err, new Error('Indiquez la source de la base')); body = { format: 'csv', kind: kind.value, content: text, source: source.value }; }
        const r = await Api.post('/api/integrations/import', body);
        result.replaceChildren(h('div', { class: r.errors.length ? 'alert-box warn' : 'info-box' }, h('strong', {}, `${r.rules} règle(s) et ${r.classes} classe(s) importée(s).`), r.errors.length ? h('ul', {}, r.errors.map((x) => h('li', {}, `${x.kind} ligne ${x.line} ignorée : ${x.message}`))) : null)); toast('Import terminé'); err.classList.add('hidden');
      } catch (x) { showErr(err, x instanceof SyntaxError ? new Error('Fichier JSON invalide') : x); } }); };
    holder.replaceChildren(form, result);
  }

  /* ============================ CONFORMITÉ ============================ */
  async function conformite(content) {
    let tab = 'lot'; const holder = h('div'); const tabs = h('div', { class: 'toolbar' });
    const show = () => { tabs.replaceChildren(seg([['lot', 'Rappel de lot'], ['register', 'Registre des produits contrôlés']], tab, (k) => { tab = k; show(); })); holder.replaceChildren(); (tab === 'lot' ? lotTab : registerTab)(holder); };
    content.replaceChildren(pageHead('Conformité & Traçabilité'), tabs, holder); show();
  }

  function lotTab(holder) {
    const lot = h('input', { class: 'search', type: 'search', placeholder: 'Numéro de lot à tracer', 'aria-label': 'Numéro de lot' }); const out = h('div');
    const go = async () => {
      if (!lot.value.trim()) return;
      try {
        const { lots } = await Api.get(`/api/conformite/lot-trace?${qs({ lotNumber: lot.value.trim() })}`);
        out.replaceChildren(...lots.map((l) => {
          const people = new Map(); l.movements.filter((m) => m.patient && ['dispensation', 'sale'].includes(m.type)).forEach((m) => people.set(`${m.patient}|${m.phone}`, { name: m.patient, phone: m.phone, ref: m.reference }));
          return h('div', { class: 'card' }, h('h2', {}, `${l.product.name} — lot ${l.lotNumber}`), h('p', { class: 'muted' }, `Péremption ${fmtDate(l.expiryDate)} · ${l.remaining} unité(s) encore en stock`),
            h('div', { class: 'stats' }, stat(l.totals.received, 'Reçues'), stat(l.totals.dispensed, 'Délivrées sur ordonnance', 'warn'), stat(l.totals.soldOverCounter, 'Vendues au comptoir', 'warn'), stat(l.totals.returned, 'Retournées')),
            people.size ? h('div', { class: 'alert-box warn' }, h('strong', {}, `${people.size} patient(s) identifié(s) à contacter`), h('ul', {}, [...people.values()].map((p) => h('li', {}, `${p.name}${p.phone ? ` — ${p.phone}` : ' — (pas de téléphone)'} (${p.ref})`)))) : h('div', { class: 'info-box' }, 'Aucun patient identifié sur ce lot (les ventes comptoir ne sont pas nominatives).'),
            table(['Date', 'Mouvement', 'Quantité', 'Référence', 'Patient', 'Opérateur'], l.movements.map((m) => h('tr', {}, h('td', {}, fmtDateTime(m.date)), h('td', {}, m.typeLabel), h('td', { class: 'num' }, m.quantity > 0 ? `+${m.quantity}` : m.quantity), h('td', {}, m.reference || '—'), h('td', {}, m.patient || '—'), h('td', { class: 'small muted' }, m.user || '—'))), 'Aucun mouvement.'));
        }));
      } catch (e) { out.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    };
    lot.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    holder.replaceChildren(h('div', { class: 'info-box' }, 'En cas de rappel d’un lot, retrouvez où il est passé : entrées, ventes, délivrances et patients concernés. Chaque recherche est tracée dans le journal d’audit.'), h('div', { class: 'toolbar' }, lot, h('button', { class: 'btn primary', onclick: go }, 'Tracer le lot')), out);
  }

  function registerTab(holder) {
    const iso = (d) => UI.today(d); const now = new Date();
    const from = h('input', { type: 'date', value: iso(new Date(now - 29 * 864e5)), 'aria-label': 'Début' }); const to = h('input', { type: 'date', value: todayStr(), 'aria-label': 'Fin' }); const out = h('div');
    const load = async () => {
      try {
        const { products } = await Api.get(`/api/conformite/controlled-register?${qs({ from: from.value, to: to.value })}`);
        out.replaceChildren(...(products.length ? products.map((p) => h('div', { class: 'card' }, h('h2', {}, p.name), h('p', { class: 'muted' }, `${p.dci || ''} — solde d’ouverture ${p.opening} · solde de clôture ${p.closing}`),
          table(['Date', 'Mouvement', 'Quantité', 'Solde', 'Lot', 'Motif', 'Opérateur'], p.movements.map((m) => h('tr', {}, h('td', {}, fmtDateTime(m.date)), h('td', {}, m.typeLabel), h('td', { class: 'num' }, m.quantity > 0 ? `+${m.quantity}` : m.quantity), h('td', { class: 'num' }, m.balance), h('td', {}, m.lotNumber || '—'), h('td', {}, m.reason || '—'), h('td', { class: 'small muted' }, m.user || '—'))), 'Aucun mouvement sur la période.'))) : [h('div', { class: 'card empty' }, 'Aucun produit contrôlé. Cochez « Produit contrôlé » sur la fiche produit (Stocks) pour l’inscrire au registre.')]));
      } catch (e) { out.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
    };
    const exp = can('conformite:export') && h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { try { await Api.download(`/api/conformite/controlled-register.csv?${qs({ from: from.value, to: to.value })}`, `registre_controles_${from.value}_${to.value}.csv`); } catch (x) { toastErr(x); } }) }, 'Exporter (CSV)');
    holder.replaceChildren(h('div', { class: 'toolbar' }, field('Du', from), field('Au', to), h('button', { class: 'btn primary', onclick: load }, 'Afficher'), exp), out); load();
  }

  window.ModuleViews = { ...(window.ModuleViews || {}), integrations, conformite };
})();
