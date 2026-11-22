'use strict';
const { h, toast, modal, field, crossIcon, fmtDate, fmtDateTime, fmtDay, showTempPassword } = UI;
const root = document.getElementById('app');

const ROLE_LABELS = { superadmin: 'Superadmin', admin: 'Admin Pharmacie', gerant: 'Gérant local', pharmacien: 'Pharmacien', preparateur: 'Préparateur', caissier: 'Caissier', personnalise: 'Personnalisé' };
const hasView = (m) => !!(window.ModuleViews && window.ModuleViews[m]);
const MODULE_LABELS = { patients: 'Patients', dispensation: 'Dispensation', stocks: 'Stocks & Inventaire', achats: 'Achats & Fournisseurs', ventes: 'Ventes & Caisse', rapports: 'Rapports & Pilotage', rh: 'RH & Planning', crm: 'CRM & Fidélité', integrations: 'Intégrations', conformite: 'Conformité & Traçabilité' };
const PERM_LABELS = { read: 'Consulter', write: 'Créer / modifier', delete: 'Supprimer', validate: 'Valider', adjust: 'Ajuster', approve: 'Approuver', refund: 'Rembourser', export: 'Exporter' };
const STATUS = { active: ['Actif', 'ok'], suspended: ['Suspendu', 'warn'], expired: ['Expiré', 'bad'] };

let me = null;       // utilisateur courant
let groupSites = []; // pharmacies du groupe (Admin d'une pharmacie multi-sites)
const RANKS = { superadmin: 100, admin: 30, gerant: 20 };   // les autres rôles : 10 (même hiérarchie que le serveur)
const rankOf = (r) => RANKS[r] || 10;
const canManageUser = (u) => u.id !== me.id && rankOf(me.role) > rankOf(u.role);
let view = 'dashboard';

const errBox = () => h('div', { class: 'form-error hidden', role: 'alert' });
const showErr = (box, e) => { box.textContent = e.message; box.classList.remove('hidden'); };
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

/* ================= Connexion ================= */
function renderLogin(step = {}) {
  const err = errBox();
  const form = h('form', { class: 'login-form', novalidate: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, step.tempToken ? 'Vérifier le code' : 'Se connecter');

  if (step.tempToken) {
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true });
    form.append(h('h2', {}, 'Vérification en deux étapes'), h('p', { class: 'muted' }, 'Saisissez le code à 6 chiffres de votre application d’authentification.'), err, field('Code de vérification', code), submit);
    form.onsubmit = (e) => { e.preventDefault(); busy(submit, async () => {
      try { afterAuth(await Api.postPublic('/api/auth/2fa/login', { tempToken: step.tempToken, code: code.value })); } catch (x) { showErr(err, x); }
    }); };
  } else {
    const email = h('input', { type: 'email', autocomplete: 'username', required: true });
    const pwd = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    form.append(h('h2', {}, 'Connexion'), h('p', { class: 'muted' }, 'Accédez à votre espace de gestion.'), err, field('Adresse e-mail', email), field('Mot de passe', pwd), submit);
    form.onsubmit = (e) => { e.preventDefault(); busy(submit, async () => {
      try {
        const d = await Api.postPublic('/api/auth/login', { email: email.value, password: pwd.value });
        if (d.requires2fa) return renderLogin({ tempToken: d.tempToken });
        afterAuth(d);
      } catch (x) { showErr(err, x); }
    }); };
  }
  root.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'login-side' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, crossIcon()), 'Pharmacie Manager Pro'),
      h('div', {}, h('h1', {}, 'Votre officine, de la dispensation à la caisse.'), h('p', {}, 'Stocks, ordonnances et équipe réunis dans un seul outil sécurisé, conçu pour les pharmacies.')),
      h('p', { class: 'small' }, 'Données de santé protégées : accès contrôlés et journal d’audit.'), crossIcon('cross')),
    h('div', { class: 'login-form-wrap' }, form)));
}

async function afterAuth(d) {
  Api.setTokens(d.accessToken);
  await boot();
}

/* ================= Changement de mot de passe obligatoire ================= */
function renderForcedPassword() {
  const err = errBox();
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer le mot de passe');
  const form = h('form', { class: 'login-form', novalidate: true }, h('h2', {}, 'Choisissez votre mot de passe'),
    h('p', { class: 'muted' }, 'Pour votre sécurité, remplacez le mot de passe temporaire avant de continuer.'), err,
    field('Mot de passe temporaire', cur), field('Nouveau mot de passe', n1, '10 caractères minimum, avec au moins une lettre et un chiffre'), field('Confirmer le nouveau mot de passe', n2), btn,
    h('button', { class: 'btn', type: 'button', onclick: logout }, 'Annuler'));
  form.onsubmit = (e) => { e.preventDefault(); busy(btn, async () => {
    if (n1.value !== n2.value) return showErr(err, new Error('Les mots de passe ne correspondent pas'));
    try {
      await Api.post('/api/auth/change-password', { currentPassword: cur.value, newPassword: n1.value });
      Api.clear(); toast('Mot de passe modifié. Reconnectez-vous.'); renderLogin();
    } catch (x) { showErr(err, x); }
  }); };
  root.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'login-side' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, crossIcon()), 'Pharmacie Manager Pro'), h('div'), h('div')), h('div', { class: 'login-form-wrap' }, form)));
}

/* ================= Shell ================= */
function navItems() {
  if (me.role === 'superadmin') {
    return [['dashboard', 'Tableau de bord'], ['tenants', 'Pharmacies'], ['audit', 'Journal d’audit'], ['account', 'Mon compte']];
  }
  const items = [['dashboard', 'Tableau de bord']];
  if (me.isGroupAdmin) items.push(['groupe', 'Mes pharmacies'], ['groupe-rapports', 'Vue du groupe']);
  if (me.role === 'gerant' && me.isSubsite && !me.acting) items.push(['site-acces', 'Accès du groupe']);
  if (me.inGroup && me.permissions.includes('stocks:read')) items.push(['transferts', 'Transferts de stock']);
  if (me.permissions.includes('users:read')) items.push(['users', 'Employés']);
  if (me.permissions.includes('audit:read')) items.push(['audit', 'Journal d’audit']);
  const mods = me.enabledModules.filter((m) => me.permissions.some((p) => p.startsWith(`${m}:`)));
  return { main: items, mods, tail: [['account', 'Mon compte']] };
}

function renderShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigation principale' });
  const add = (key, label, soon) => nav.append(h('button', { type: 'button', 'aria-current': view === key ? 'page' : null, onclick: () => go(key) }, label, soon && h('span', { class: 'soon' }, 'bientôt')));
  const items = navItems();
  if (Array.isArray(items)) items.forEach(([k, l]) => add(k, l));
  else {
    items.main.forEach(([k, l]) => add(k, l));
    if (items.mods.length) { nav.append(h('div', { class: 'nav-sep' }, 'Modules activés')); items.mods.forEach((m) => add(`mod:${m}`, MODULE_LABELS[m] || m, !hasView(m))); }
    nav.append(h('div', { class: 'nav-sep' }, 'Compte')); items.tail.forEach(([k, l]) => add(k, l));
  }
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, crossIcon()), 'Pharmacie Manager Pro'),
    h('div', { class: 'tenant' }, me.tenantName || 'Administration de la plateforme'),
    me.isGroupAdmin && groupSites.length > 1 && h('select', { class: 'site-switch', 'aria-label': 'Pharmacie de travail', onchange: (e) => switchSite(e.target.value) },
      groupSites.map((s) => h('option', { value: s.id, selected: s.id === me.tenantId }, `${s.isMain ? '★ ' : ''}${s.name}`))),
    me.acting && h('div', { class: 'acting-note' }, me.patientDataRestricted ? 'Admin du groupe · dossiers patients fermés (accès accordé par le gérant local)' : 'Admin du groupe · accès patients accordé'), nav);
  const content = h('div', { class: 'content', id: 'content', tabindex: '-1' });
  const clockBox = h('div'); if (me.enabledModules && me.enabledModules.includes('rh') && me.role !== 'superadmin') initClock(clockBox);
  root.replaceChildren(h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' },
    h('header', { class: 'topbar' },
      h('button', { class: 'btn sm menu-btn', type: 'button', 'aria-label': 'Ouvrir le menu', onclick: () => sidebar.classList.toggle('open') }, 'Menu'),
      clockBox,
      h('div', { class: 'row' }, h('div', { class: 'who' }, h('strong', {}, me.fullName || me.email), h('div', { class: 'small muted' }, ROLE_LABELS[me.role])),
        h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Se déconnecter'))),
    content)));
  return content;
}

/** Pointage personnel : accessible à tous les employés quand le module RH est activé (aucun droit RH requis). */
async function initClock(box) {
  const btn = h('button', { class: 'btn sm clock-btn', type: 'button' }, '…');
  const apply = (open) => { btn.textContent = open ? `Pointer le départ (arrivé à ${UI.fmtTime(open.clockIn)})` : 'Pointer l’arrivée'; btn.classList.toggle('success', !open); btn.dataset.open = open ? '1' : ''; };
  btn.onclick = () => busy(btn, async () => { try { const out = await Api.post('/api/rh/clock', { action: btn.dataset.open ? 'out' : 'in' }); apply(btn.dataset.open ? null : { clockIn: out.clockIn }); toast(btn.dataset.open ? 'Arrivée pointée' : 'Départ pointé'); } catch (e) { toast(e.message, true); } });
  box.append(btn); try { apply((await Api.get('/api/rh/clock')).open); } catch { box.replaceChildren(); }
}

async function go(key) { view = key; await render(); }

async function render() {
  const content = renderShell();
  try {
    if (view.startsWith('mod:')) { const k = view.slice(4); return hasView(k) ? await window.ModuleViews[k](content) : placeholder(content, k); }
    const views = me.role === 'superadmin'
      ? { dashboard: saDashboard, tenants: saTenants, audit: saAudit, account: account }
      : { dashboard: tenantDashboard, users: tenantUsers, audit: tenantAudit, account: account, groupe: groupeSites, 'groupe-rapports': groupeReport, 'site-acces': siteAccess, transferts };
    await (views[view] || views.dashboard)(content);
  } catch (e) { content.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
}

function placeholder(content, key) {
  content.replaceChildren(h('div', { class: 'card placeholder' }, h('h2', {}, MODULE_LABELS[key] || key),
    h('p', { class: 'muted' }, 'Ce module est activé pour votre pharmacie. Son interface sera disponible dans une prochaine livraison.')));
}

const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', {}, title), h('div', { class: 'row' }, actions));
const stat = (n, l, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l));
const table = (heads, rows, emptyMsg) => rows.length
  ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows)))
  : h('div', { class: 'empty' }, emptyMsg);
const pct = (n, total) => `w${Math.min(100, Math.round(((total ? n / total : 0) * 10)) * 10)}`;

/* ================= Superadmin ================= */
async function saDashboard(content) {
  const d = await Api.get('/api/superadmin/dashboard');
  const t = d.tenants;
  content.replaceChildren(pageHead('Tableau de bord global'),
    h('div', { class: 'stats' }, stat(t.total, 'Pharmacies'), stat(t.active, 'Abonnements actifs', 'green'), stat(t.expiring_soon, 'Expirent sous 30 jours', 'warn'),
      stat(t.suspended + t.expired, 'Suspendues ou expirées', 'red'), stat(d.localUsers, 'Utilisateurs actifs')),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Adoption des modules'), h('br'),
        d.moduleAdoption.length ? d.moduleAdoption.map((m) => h('div', { class: 'field' }, h('div', { class: 'row' }, h('span', {}, MODULE_LABELS[m.module_key] || m.module_key), h('span', { class: 'muted' }, `${m.n} / ${t.total}`)), h('div', { class: 'bar' }, h('span', { class: pct(m.n, t.total) }))))
          : h('p', { class: 'muted' }, 'Aucun module activé pour le moment.')),
      h('div', { class: 'card' }, h('h2', {}, 'Dernières pharmacies'), h('br'),
        table(['Nom', 'Ville', 'Créée le'], d.recentTenants.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.city || '—'), h('td', {}, fmtDate(r.created_at)))), 'Aucune pharmacie. Créez la première depuis « Pharmacies ».'))));
}

async function saTenants(content) {
  const { tenants } = await Api.get('/api/superadmin/tenants');
  const kids = new Map(); tenants.filter((t) => t.parent_id).forEach((t) => kids.set(t.parent_id, [...(kids.get(t.parent_id) || []), t]));
  const ordered = tenants.filter((t) => !t.parent_id).flatMap((t) => [t, ...(kids.get(t.id) || [])]);   // chaque sous-pharmacie sous sa pharmacie principale
  const rows = ordered.map((t) => {
    const [label, cls] = STATUS[t.status];
    return h('tr', {}, h('td', {}, h('strong', {}, `${t.parent_id ? '↳ ' : ''}${t.name}`), h('div', { class: 'small muted' }, [t.city, t.timezone, t.parent_id ? 'sous-pharmacie' : t.max_subsites ? `groupe ${t.site_count}/${t.max_subsites}` : null].filter(Boolean).join(' · '))),
      h('td', {}, h('span', { class: `badge ${cls}` }, label)), h('td', {}, fmtDate(t.subscription_end)),
      h('td', {}, h('div', { class: 'chips' }, t.modules.length ? t.modules.map((m) => h('span', { class: 'badge' }, MODULE_LABELS[m] || m)) : h('span', { class: 'muted small' }, 'Aucun'))),
      h('td', {}, t.parent_id ? h('span', { class: 'muted small' }, 'Admin du groupe') : t.admin_count ? 'Oui' : h('span', { class: 'badge warn' }, 'À créer')), h('td', {}, t.user_count),
      h('td', {}, h('button', { class: 'btn sm', onclick: () => tenantDialog(t) }, 'Gérer')));
  });
  content.replaceChildren(pageHead('Pharmacies', h('button', { class: 'btn primary', onclick: createTenantDialog }, 'Nouvelle pharmacie')),
    h('div', { class: 'card' }, table(['Pharmacie', 'Statut', 'Fin d’abonnement', 'Modules', 'Admin', 'Utilisateurs', ''], rows, 'Aucune pharmacie pour l’instant. Créez la première pour commencer.')));
}

/** Champ fuseau : saisie libre avec suggestions (le serveur valide le nom IANA et le connaît côté base). */
const COMMON_TZ = ['UTC', 'Africa/Abidjan', 'Africa/Bamako', 'Africa/Dakar', 'Africa/Conakry', 'Africa/Ouagadougou', 'Africa/Niamey', 'Africa/Lome', 'Africa/Porto-Novo', 'Africa/Lagos', 'Africa/Douala', 'Africa/Libreville', 'Africa/Kinshasa', 'Africa/Lubumbashi', 'Africa/Brazzaville', 'Africa/Casablanca', 'Africa/Tunis', 'Africa/Algiers', 'Europe/Paris'];
function tzField(current) {
  const listId = 'tz_list'; document.getElementById(listId)?.remove();
  const dl = h('datalist', { id: listId }, COMMON_TZ.map((z) => h('option', { value: z })));
  const el = h('input', { type: 'text', value: current, maxlength: '64', list: listId, autocomplete: 'off', spellcheck: 'false' });
  document.body.append(dl);
  return { el, value: () => el.value.trim() || 'UTC' };
}

async function moduleChecklist(selected) {
  const { modules } = await Api.get('/api/superadmin/modules');
  const boxes = modules.filter((m) => !m.isCore).map((m) => ({ key: m.key, el: h('input', { type: 'checkbox', value: m.key, checked: selected.includes(m.key) }), m }));
  const wrap = h('div', { class: 'check-list' }, boxes.map(({ el, m }) => h('label', {}, el, h('span', {}, h('strong', {}, m.label), h('div', { class: 'small muted' }, m.description)))));
  return { el: wrap, value: () => boxes.filter((b) => b.el.checked).map((b) => b.key) };
}

async function createTenantDialog() {
  const err = errBox();
  const name = h('input', { type: 'text', required: true, maxlength: '120' });
  const city = h('input', { type: 'text', maxlength: '80' });
  const phone = h('input', { type: 'tel', maxlength: '40' });
  const email = h('input', { type: 'email' });
  const plan = h('select', {}, ['starter', 'standard', 'premium'].map((p) => h('option', { value: p }, p[0].toUpperCase() + p.slice(1))));
  const end = h('input', { type: 'date' });
  const tzInput = tzField('UTC');
  const maxSub = h('input', { type: 'number', min: '0', max: '100', value: '0' });
  const mods = await moduleChecklist([]);
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Créer la pharmacie');
  const form = h('form', { novalidate: true }, err, field('Nom de la pharmacie', name),
    h('div', { class: 'row' }, field('Ville', city), field('Téléphone', phone)), h('div', { class: 'row' }, field('E-mail de contact', email), field('Formule', plan)),
    h('div', { class: 'row' }, field('Fin d’abonnement', end), field('Fuseau horaire', tzInput.el, 'Nom IANA, ex. Africa/Bamako. Détermine les jours des rapports, de la caisse et du pointage.')), field('Sous-pharmacies autorisées', maxSub, '0 = pharmacie simple. Sinon pharmacie multi-sites : son Admin (unique) pourra ouvrir jusqu’à ce nombre de sous-pharmacies.'),
    h('strong', {}, 'Modules à activer'), mods.el,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal('Nouvelle pharmacie', form, { wide: true });
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    try { await Api.post('/api/superadmin/tenants', { name: name.value, city: city.value, phone: phone.value, email: email.value, plan: plan.value, subscriptionEnd: end.value || null, timezone: tzInput.value(), maxSubsites: Number(maxSub.value) || 0, modules: mods.value() });
      m.close(); toast('Pharmacie créée. Créez maintenant son Admin.'); go('tenants'); } catch (x) { showErr(err, x); }
  }); };
}

async function tenantDialog(t) {
  const err = errBox();
  const { admin } = await Api.get(`/api/superadmin/tenants/${t.id}/admin`);
  const mods = await moduleChecklist(t.modules);
  const status = h('select', {}, Object.entries(STATUS).map(([k, [l]]) => h('option', { value: k, selected: t.status === k }, l)));
  const end = h('input', { type: 'date', value: fmtDay(t.subscription_end) });
  const tzInput = tzField(t.timezone || 'UTC');
  const maxSub = t.parent_id ? null : h('input', { type: 'number', min: String(t.site_count || 0), max: '100', value: String(t.max_subsites || 0) });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer');
  const adminBlock = t.parent_id
    ? h('div', { class: 'card' }, h('strong', {}, 'Administration'), h('p', { class: 'small muted' }, 'Cette sous-pharmacie est administrée par l’Admin du groupe, qui y désigne un gérant local.'))
    : admin
    ? h('div', { class: 'card' }, h('strong', {}, 'Admin de la pharmacie'), h('p', { class: 'small' }, `${admin.full_name} — ${admin.email}`),
        h('p', { class: 'small muted' }, `Dernière connexion : ${fmtDateTime(admin.last_login_at)} · 2FA ${admin.totp_enabled ? 'activée' : 'non activée'}`),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!confirm('Générer un nouveau mot de passe temporaire pour cet Admin ?')) return;
          try { const r = await Api.post(`/api/superadmin/tenants/${t.id}/admin/reset-password`); showTempPassword(admin.email, r.temporaryPassword); } catch (x) { toast(x.message, true); } } }, 'Réinitialiser le mot de passe'),
        h('button', { class: 'btn sm', type: 'button', style: 'margin-left:.5rem', onclick: () => { m.close(); createAdminDialog(t, true); } }, 'Attribuer à une autre personne'))
    : h('div', { class: 'card' }, h('strong', {}, 'Créer le premier Admin'), h('p', { class: 'small muted' }, 'Un mot de passe temporaire sera généré et affiché une seule fois.'),
        h('button', { class: 'btn success sm', type: 'button', onclick: () => { m.close(); createAdminDialog(t); } }, 'Créer l’Admin'));
  const form = h('form', { novalidate: true }, err, h('div', { class: 'row' }, field('Statut', status), !t.parent_id && field('Fin d’abonnement', end)),
    !t.parent_id && field('Sous-pharmacies autorisées', maxSub, `Nombre de sous-pharmacies que l’Admin du groupe peut ouvrir (${t.site_count || 0} ouverte(s)). 0 = pharmacie simple.`),
    field('Fuseau horaire', tzInput.el, 'Nom IANA. Changer le fuseau déplace les frontières de « jour » : les rapports passés sont recalculés avec le nouveau fuseau.'),
    h('strong', {}, 'Modules activés'), h('p', { class: 'small muted' }, 'Désactiver un module retire immédiatement les droits associés à tous les employés.'), mods.el, adminBlock,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Fermer'), save));
  const m = modal(t.name, form, { wide: true });
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    try {
      await Api.patch(`/api/superadmin/tenants/${t.id}`, { status: status.value, ...(t.parent_id ? {} : { subscriptionEnd: end.value || null, maxSubsites: Number(maxSub.value) || 0 }), timezone: tzInput.value() });
      await Api.put(`/api/superadmin/tenants/${t.id}/modules`, { modules: mods.value() });
      m.close(); toast('Modifications enregistrées'); go('tenants');
    } catch (x) { showErr(err, x); }
  }); };
}

function createAdminDialog(t, replace = false) {
  const err = errBox();
  const fullName = h('input', { type: 'text', required: true });
  const email = h('input', { type: 'email', required: true });
  const save = h('button', { class: 'btn success', type: 'submit' }, replace ? 'Remplacer l’Admin' : 'Créer l’Admin');
  const form = h('form', { novalidate: true }, err, replace && h('p', { class: 'small muted' }, 'L’Admin actuel sera désactivé et ses sessions fermées. Le nouvel Admin reçoit un mot de passe temporaire.'),
    field('Nom complet', fullName), field('E-mail de connexion', email),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal(`Admin de ${t.name}`, form);
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    try { const r = await Api.post(`/api/superadmin/tenants/${t.id}/admin`, { fullName: fullName.value, email: email.value, replace });
      m.close(); showTempPassword(r.user.email, r.temporaryPassword, () => go('tenants')); } catch (x) { showErr(err, x); }
  }); };
}

const ACTION_LABELS = {
  'auth.login': 'Connexion', 'auth.login_failed': 'Échec de connexion', 'auth.2fa_failed': 'Échec 2FA', 'auth.password_changed': 'Mot de passe modifié',
  'auth.2fa_enabled': '2FA activée', 'auth.2fa_disabled': '2FA désactivée', 'tenant.created': 'Pharmacie créée', 'tenant.updated': 'Pharmacie modifiée',
  'tenant.modules_updated': 'Modules modifiés', 'tenant.admin_created': 'Admin créé', 'tenant.admin_password_reset': 'Mot de passe Admin réinitialisé',
  'group.site_created': 'Sous-pharmacie ouverte', 'group.site_updated': 'Sous-pharmacie modifiée', 'tenant.admin_replaced': 'Admin remplacé',
  'site.patient_access_granted': 'Accès patients accordé à l’Admin du groupe', 'site.patient_access_revoked': 'Accès patients retiré à l’Admin du groupe',
  'transfer.created': 'Transfert créé', 'transfer.sent': 'Transfert expédié', 'transfer.received': 'Transfert reçu', 'transfer.cancelled': 'Transfert annulé',
  'transfer.refused': 'Transfert refusé', 'transfer.returned': 'Transfert repris', 'stock.transfer_in': 'Entrée par transfert',
  'user.created': 'Employé créé', 'user.updated': 'Employé modifié', 'user.password_reset': 'Mot de passe employé réinitialisé',
};
const auditTable = (logs, withTenant) => table(['Date', 'Action', 'Utilisateur', ...(withTenant ? ['Pharmacie'] : []), 'IP'],
  logs.map((l) => h('tr', {}, h('td', {}, fmtDateTime(l.created_at)), h('td', {}, h('span', { class: `badge${l.action.includes('failed') ? ' bad' : ''}` }, ACTION_LABELS[l.action] || l.action)),
    h('td', {}, l.user_email || (l.meta && l.meta.via_group_admin ? 'Admin du groupe' : '—')), withTenant && h('td', {}, l.tenant_name || '—'), h('td', { class: 'small muted' }, l.ip || '—'))), 'Aucune activité enregistrée.');
async function saAudit(content) { const { logs } = await Api.get('/api/superadmin/audit'); content.replaceChildren(pageHead('Journal d’audit global'), h('div', { class: 'card' }, auditTable(logs, true))); }
async function tenantAudit(content) { const { logs } = await Api.get('/api/users/audit/logs'); content.replaceChildren(pageHead('Journal d’audit'), h('div', { class: 'card' }, auditTable(logs, false))); }

/* ================= Pharmacie (Admin local & employés) ================= */
async function tenantDashboard(content) {
  const mods = me.enabledModules;
  content.replaceChildren(pageHead(`Bienvenue, ${me.fullName.split(' ')[0]}`),
    h('div', { class: 'stats' }, stat(mods.length, 'Modules activés', 'green'), stat(me.permissions.length, 'Vos permissions')),
    h('div', { class: 'card' }, h('h2', {}, 'Modules de votre pharmacie'), h('br'),
      mods.length ? h('div', { class: 'chips' }, mods.map((m) => h('span', { class: 'badge ok' }, MODULE_LABELS[m] || m)))
        : h('p', { class: 'muted' }, 'Aucun module n’est encore activé. Contactez votre administrateur de plateforme pour activer vos modules.'),
      ['admin', 'gerant'].includes(me.role) && h('p', { class: 'small muted' }, 'Rendez-vous dans « Employés » pour créer votre équipe et définir leurs accès.'),
      me.isGroupAdmin && h('p', { class: 'small muted' }, 'Pharmacie multi-sites : « Mes pharmacies » pour ouvrir vos sous-pharmacies et désigner leurs gérants, « Vue du groupe » pour les chiffres consolidés.')));
}

async function tenantUsers(content) {
  const [{ users }, catalog] = await Promise.all([Api.get('/api/users'), Api.get('/api/users/catalog')]);
  const canWrite = me.permissions.includes('users:write');
  const rows = users.map((u) => h('tr', {}, h('td', {}, h('strong', {}, u.full_name), h('div', { class: 'small muted' }, u.email)),
    h('td', {}, ROLE_LABELS[u.role]), h('td', {}, u.effectivePermissions.length), h('td', {}, h('span', { class: `badge ${u.is_active ? 'ok' : 'bad'}` }, u.is_active ? 'Actif' : 'Désactivé')),
    h('td', {}, fmtDateTime(u.last_login_at)),
    h('td', {}, canWrite && canManageUser(u) && h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => userDialog(catalog, u) }, 'Modifier'),
      h('button', { class: 'btn sm', onclick: async () => { if (!confirm(`Réinitialiser le mot de passe de ${u.full_name} ?`)) return;
        try { const r = await Api.post(`/api/users/${u.id}/reset-password`); showTempPassword(u.email, r.temporaryPassword); } catch (x) { toast(x.message, true); } } }, 'Mot de passe')))));
  content.replaceChildren(pageHead('Employés', canWrite && h('button', { class: 'btn primary', onclick: () => userDialog(catalog) }, 'Nouvel employé')),
    h('div', { class: 'card' }, table(['Employé', 'Rôle', 'Permissions', 'Statut', 'Dernière connexion', ''], rows, 'Aucun employé.')));
}

function userDialog(catalog, user) {
  const err = errBox(); const editing = !!user;
  const fullName = h('input', { type: 'text', required: true, value: user?.full_name || '' });
  const email = h('input', { type: 'email', required: true, value: user?.email || '', disabled: editing });
  const role = h('select', {}, catalog.roles.map((r) => h('option', { value: r.key, selected: user?.role === r.key }, r.label)));
  const active = h('input', { type: 'checkbox', checked: user ? user.is_active : true });
  const perms = new Map(); // permission → input
  const groups = catalog.modules.map((mod) => h('div', { class: 'perm-group' }, h('h3', {}, mod.label), h('div', { class: 'check-list' },
    mod.permissions.map((p) => { const cb = h('input', { type: 'checkbox', checked: false }); perms.set(p, cb);
      return h('label', {}, cb, PERM_LABELS[p.split(':')[1]] || p); }))));
  const hint = h('p', { class: 'small muted' });
  const refresh = () => {
    const defaults = new Set(catalog.roles.find((r) => r.key === role.value).defaults);
    const extras = new Set(user?.permissions || []);
    perms.forEach((cb, p) => { if (!cb.dataset.touched) cb.checked = defaults.has(p) || extras.has(p); });
    hint.textContent = role.value === 'personnalise' ? 'Rôle personnalisé : cochez uniquement les accès nécessaires.' : 'Les accès du rôle sont pré-cochés ; ajoutez ou retirez selon le besoin.';
  };
  perms.forEach((cb) => cb.addEventListener('change', () => { cb.dataset.touched = '1'; }));
  role.addEventListener('change', () => { perms.forEach((cb) => delete cb.dataset.touched); refresh(); });
  refresh();
  const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Enregistrer' : 'Créer l’employé');
  const form = h('form', { novalidate: true }, err, field('Nom complet', fullName), field('E-mail de connexion', email), field('Rôle', role),
    editing && h('label', { class: 'check-list' }, h('span', {}, active, ' Compte actif')),
    h('strong', {}, 'Accès par module'), hint,
    catalog.modules.length ? groups : h('p', { class: 'muted' }, 'Aucun module métier activé : seuls les comptes sans accès peuvent être créés.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal(editing ? `Modifier ${user.full_name}` : 'Nouvel employé', form, { wide: true });
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    // on n'enregistre comme « additionnelles » que les permissions hors défaut du rôle
    const defaults = new Set(catalog.roles.find((r) => r.key === role.value).defaults);
    const extra = [...perms].filter(([p, cb]) => cb.checked && !defaults.has(p)).map(([p]) => p);
    const missing = [...defaults].filter((p) => perms.has(p) && !perms.get(p).checked);
    // retrait d'un droit du rôle → on bascule en rôle « personnalisé » avec liste explicite
    const explicit = [...perms].filter(([, cb]) => cb.checked).map(([p]) => p);
    const body = { fullName: fullName.value, role: missing.length ? 'personnalise' : role.value, permissions: missing.length ? explicit : extra };
    try {
      if (editing) { await Api.patch(`/api/users/${user.id}`, { ...body, isActive: active.checked }); m.close(); toast('Employé modifié'); go('users'); }
      else { const r = await Api.post('/api/users', { ...body, email: email.value }); m.close(); showTempPassword(r.user.email, r.temporaryPassword, () => go('users')); }
    } catch (x) { showErr(err, x); }
  }); };
}

/* ================= Mon compte (mot de passe + 2FA) ================= */
async function account(content) {
  const { user } = await Api.get('/api/auth/me'); me = { ...me, ...user }; UI.setTimezone(me.timezone);
  const pErr = errBox(); const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Changer le mot de passe');
  const pForm = h('form', { novalidate: true }, pErr, field('Mot de passe actuel', cur), field('Nouveau mot de passe', n1, '10 caractères minimum, avec au moins une lettre et un chiffre'), pBtn);
  pForm.onsubmit = (e) => { e.preventDefault(); busy(pBtn, async () => {
    try { await Api.post('/api/auth/change-password', { currentPassword: cur.value, newPassword: n1.value }); Api.clear(); toast('Mot de passe modifié. Reconnectez-vous.'); renderLogin(); } catch (x) { showErr(pErr, x); }
  }); };

  const tfa = h('div', { class: 'card' }, h('h2', {}, 'Double authentification (2FA)'), h('br'));
  if (me.totpEnabled) {
    const err = errBox(); const pwd = h('input', { type: 'password' }); const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6' });
    const b = h('button', { class: 'btn danger', type: 'submit' }, 'Désactiver la 2FA');
    const f = h('form', { novalidate: true }, h('p', {}, h('span', { class: 'badge ok' }, 'Activée')), err, field('Mot de passe', pwd), field('Code actuel', code), b);
    f.onsubmit = (e) => { e.preventDefault(); busy(b, async () => { try { await Api.post('/api/auth/2fa/disable', { password: pwd.value, code: code.value }); toast('2FA désactivée'); go('account'); } catch (x) { showErr(err, x); } }); };
    tfa.append(f);
  } else {
    tfa.append(h('p', { class: 'muted' }, 'Ajoutez une seconde étape de connexion avec une application d’authentification (Google Authenticator, Authy, Microsoft Authenticator).'),
      h('button', { class: 'btn success', onclick: setup2fa }, 'Activer la 2FA'));
  }
  content.replaceChildren(pageHead('Mon compte'), h('div', { class: 'grid-2' }, h('div', { class: 'card' }, h('h2', {}, 'Mot de passe'), h('br'), pForm), tfa));
}

async function setup2fa() {
  try {
    const s = await Api.post('/api/auth/2fa/setup'); const err = errBox(); const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', required: true });
    const b = h('button', { class: 'btn success', type: 'submit' }, 'Activer');
    const f = h('form', { novalidate: true }, h('p', {}, 'Dans votre application d’authentification, ajoutez un compte avec la clé suivante (saisie manuelle, type « basé sur le temps ») :'),
      h('div', { class: 'secret' }, s.secret), h('br'), err, field('Code à 6 chiffres affiché par l’application', code),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), b));
    const m = modal('Activer la double authentification', f);
    f.onsubmit = (e) => { e.preventDefault(); busy(b, async () => { try { await Api.post('/api/auth/2fa/enable', { code: code.value }); m.close(); toast('2FA activée'); go('account'); } catch (x) { showErr(err, x); } }); };
  } catch (x) { toast(x.message, true); }
}

/* ================= Pharmacie multi-sites (Admin de la pharmacie principale) ================= */
const fmtMoney = (n) => `${Number(n || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} FCFA`;

async function groupeSites(content) {
  const { group, sites } = await Api.get('/api/groupe/sites');
  groupSites = sites;
  const rows = sites.map((s) => h('tr', {},
    h('td', {}, h('strong', {}, s.name), s.isMain && h('span', { class: 'badge', style: 'margin-left:.4rem' }, 'Principale'), h('div', { class: 'small muted' }, [s.city, s.timezone].filter(Boolean).join(' · '))),
    h('td', {}, h('span', { class: `badge ${(STATUS[s.status] || [])[1] || ''}` }, (STATUS[s.status] || [s.status])[0])),
    h('td', {}, s.isMain ? h('span', { class: 'muted' }, '—') : s.manager
      ? h('div', {}, h('strong', {}, s.manager.fullName), h('div', { class: 'small muted' }, s.manager.email))
      : h('span', { class: 'badge warn' }, 'À désigner')),
    h('td', {}, String(s.userCount)),
    h('td', {}, s.isMain ? h('span', { class: 'muted small' }, 'Votre pharmacie') : h('span', { class: `badge ${s.patientAccess ? 'ok' : ''}` }, s.patientAccess ? 'Accès accordé' : 'Fermés')),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => switchSite(s.id) }, 'Ouvrir'),
      !s.isMain && h('button', { class: 'btn sm', onclick: () => managerDialog(s) }, s.manager ? 'Autre gérant' : 'Désigner le gérant'),
      h('button', { class: 'btn sm', onclick: () => siteDialog(s) }, 'Modifier')))));
  const add = h('button', { class: 'btn primary', disabled: group.remaining === 0, title: group.remaining === 0 ? 'Quota atteint' : '', onclick: () => siteDialog() }, 'Nouvelle sous-pharmacie');
  content.replaceChildren(pageHead('Mes pharmacies', add),
    h('div', { class: 'stats' }, stat(`${group.used} / ${group.maxSites}`, 'Sous-pharmacies ouvertes'), stat(group.remaining, 'Places restantes', 'green')),
    h('div', { class: 'info-box' }, 'Les dossiers patients des sous-pharmacies sont fermés par défaut pour vous : seul le gérant local de chaque sous-pharmacie peut vous y donner accès (et le retirer à tout moment). Le gérant local ne voit que sa pharmacie.'),
    h('div', { class: 'card' }, table(['Pharmacie', 'Statut', 'Gérant local', 'Employés actifs', 'Dossiers patients', ''], rows, 'Aucune pharmacie.')));
}

function siteDialog(site) {
  const err = errBox(); const editing = !!site;
  const name = h('input', { type: 'text', required: true, maxlength: '120', value: site?.name || '' });
  const city = h('input', { type: 'text', maxlength: '80', value: site?.city || '' });
  const phone = h('input', { type: 'tel', maxlength: '40', value: site?.phone || '' });
  const email = h('input', { type: 'email', value: site?.email || '' });
  const tzInput = tzField(site?.timezone || me.timezone || 'UTC');
  const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Enregistrer' : 'Ouvrir la sous-pharmacie');
  const form = h('form', { novalidate: true }, err, field('Nom de la pharmacie', name), h('div', { class: 'row' }, field('Ville', city), field('Téléphone', phone)),
    h('div', { class: 'row' }, field('E-mail de contact', email), field('Fuseau horaire', tzInput.el, 'Nom IANA, ex. Africa/Bamako.')),
    !editing && h('p', { class: 'small muted' }, 'La sous-pharmacie reprend les modules de la pharmacie principale. Désignez ensuite son gérant local.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal(editing ? `Modifier ${site.name}` : 'Nouvelle sous-pharmacie', form);
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    const body = { name: name.value, city: city.value, phone: phone.value, email: email.value, timezone: tzInput.value() };
    try { if (editing) await Api.patch(`/api/groupe/sites/${site.id}`, body); else await Api.post('/api/groupe/sites', body);
      m.close(); toast(editing ? 'Pharmacie modifiée' : 'Sous-pharmacie ouverte'); groupSites = (await Api.get('/api/groupe/sites')).sites; go('groupe'); } catch (x) { showErr(err, x); }
  }); };
}

/** Désignation du gérant local : le compte est créé DANS la sous-pharmacie (il ne verra qu'elle). */
function managerDialog(site) {
  const err = errBox();
  const fullName = h('input', { type: 'text', required: true, maxlength: '120' });
  const email = h('input', { type: 'email', required: true });
  const save = h('button', { class: 'btn success', type: 'submit' }, 'Créer le gérant');
  const form = h('form', { novalidate: true }, err, field('Nom complet', fullName), field('E-mail de connexion', email),
    h('p', { class: 'small muted' }, 'Le gérant local voit uniquement cette pharmacie. Il pourra créer des employés et leur attribuer des rôles inférieurs au sien. Un mot de passe temporaire sera généré.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal(`Gérant local — ${site.name}`, form);
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    try { const r = await Api.as(site.id).post('/api/users', { fullName: fullName.value, email: email.value, role: 'gerant' });
      m.close(); showTempPassword(r.user.email, r.temporaryPassword, () => go('groupe')); } catch (x) { showErr(err, x); }
  }); };
}

async function groupeReport(content) {
  const from = h('input', { type: 'date', value: UI.today(new Date(Date.now() - 29 * 864e5)) }); const to = h('input', { type: 'date', value: UI.today() });
  const out = h('div');
  const load = async () => {
    try {
      const d = await Api.get(`/api/groupe/overview?from=${from.value}&to=${to.value}`);
      const tr = (s, bold) => h('tr', bold ? { class: 'total-row' } : {}, h('td', {}, bold ? h('strong', {}, s.name) : s.name), h('td', {}, fmtMoney(s.revenue)), h('td', {}, String(s.salesCount)), h('td', {}, fmtMoney(s.avgBasket)),
        h('td', {}, `${fmtMoney(s.margin)} (${s.marginPct} %)`), h('td', {}, fmtMoney(s.discounts)), h('td', {}, fmtMoney(s.refunded)), h('td', {}, fmtMoney(s.stockValue)), h('td', {}, fmtMoney(s.expiredValue)));
      const flat = (s) => ({ name: s.name, revenue: s.kpis.revenue, salesCount: s.kpis.salesCount, avgBasket: s.kpis.avgBasket, margin: s.kpis.margin, marginPct: s.kpis.marginPct, discounts: s.kpis.discounts, refunded: s.kpis.refunded, stockValue: s.stockValuation.value, expiredValue: s.stockValuation.expiredValue });
      out.replaceChildren(
        h('div', { class: 'stats' }, stat(fmtMoney(d.totals.revenue), 'Chiffre d’affaires', 'green'), stat(d.totals.salesCount, 'Ventes'), stat(fmtMoney(d.totals.margin), 'Marge brute'), stat(fmtMoney(d.totals.stockValue), 'Valeur du stock')),
        h('div', { class: 'card' }, table(['Pharmacie', 'CA', 'Ventes', 'Panier moyen', 'Marge', 'Remises', 'Remboursé', 'Stock', 'Stock périmé'],
          [...d.sites.map((s) => tr(flat(s))), d.sites.length > 1 && tr({ name: 'Total du groupe', ...d.totals }, true)], 'Aucune pharmacie.')),
        await groupTransfersCard(),
        d.skipped.length > 0 && h('div', { class: 'info-box' }, `Non incluses : ${d.skipped.map((s) => `${s.name} (${s.reason})`).join(' ; ')}.`),
        h('p', { class: 'small muted' }, 'Chaque pharmacie calcule ses jours dans son propre fuseau horaire. Aucune donnée patient dans cette vue.'));
    } catch (e) { out.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
  };
  content.replaceChildren(pageHead('Vue du groupe'), h('div', { class: 'card' }, h('div', { class: 'row' }, field('Du', from), field('Au', to), h('button', { class: 'btn primary', type: 'button', onclick: load }, 'Afficher'))), out);
  await load();
}

/* ================= Gérant local : accès du groupe aux dossiers patients ================= */
async function siteAccess(content) {
  const d = await Api.get('/api/site/patient-access');
  const toggle = h('button', { class: `btn ${d.granted ? '' : 'primary'}`, onclick: async () => {
    const ask = d.granted
      ? 'Retirer à l’Admin du groupe l’accès aux dossiers patients de votre pharmacie ? Le retrait est immédiat.'
      : 'Autoriser l’Admin du groupe à consulter les dossiers patients, ordonnances et la fidélité de votre pharmacie ? Chacune de ses actions sera tracée, et vous pourrez retirer cet accès à tout moment.';
    if (!window.confirm(ask)) return;
    try { await Api.put('/api/site/patient-access', { granted: !d.granted }); toast(d.granted ? 'Accès retiré' : 'Accès accordé'); go('site-acces'); } catch (x) { toast(x.message, true); }
  } }, d.granted ? 'Retirer l’accès' : 'Accorder l’accès');
  content.replaceChildren(pageHead('Accès du groupe'),
    h('div', { class: 'card' },
      h('p', {}, 'Pharmacie : ', h('strong', {}, me.tenantName), ' · Groupe : ', h('strong', {}, d.groupName)),
      h('p', {}, h('span', { class: `badge ${d.granted ? 'ok' : ''}` }, d.granted ? 'Accès accordé à l’Admin du groupe' : 'Dossiers patients fermés à l’Admin du groupe')),
      h('p', { class: 'small muted' }, 'Par défaut, l’Admin du groupe pilote votre pharmacie (stocks, achats, personnel, chiffres) sans accéder aux dossiers patients. Vous seul décidez de lui ouvrir cet accès ; il peut être retiré à tout moment.'),
      toggle));
}

/* ================= Transferts de stock entre pharmacies du groupe ================= */
const TR_STATUS = { draft: ['Brouillon', ''], in_transit: ['En transit', 'warn'], received: ['Reçu', 'ok'], cancelled: ['Annulé', ''], refused: ['Refusé — à reprendre', 'bad'], returned: ['Repris par l’expéditeur', ''], received_short: ['Reçu partiellement — écart à reprendre', 'warn'] };
const trBadge = (st) => h('span', { class: `badge ${(TR_STATUS[st] || [])[1] || ''}` }, (TR_STATUS[st] || [st])[0]);

async function transferts(content) {
  const canT = me.permissions.includes('stocks:transfer');
  let dir = '';
  const holder = h('div', { class: 'card' });
  const sel = h('select', { 'aria-label': 'Filtrer', onchange: () => { dir = sel.value; load(); } }, [['', 'Tous les transferts'], ['out', 'Envoyés'], ['in', 'Reçus']].map(([v, l]) => h('option', { value: v }, l)));
  async function load() {
    try {
      const { transfers } = await (dir ? Api.get(`/api/transferts?direction=${dir}`) : Api.get('/api/transferts'));
      holder.replaceChildren(table(['N°', 'Sens', 'Pharmacie', 'Contenu', 'Statut', 'Date', ''], transfers.map((t) => h('tr', {},
        h('td', {}, h('strong', {}, t.number)), h('td', {}, t.direction === 'out' ? 'Envoyé à' : 'Reçu de'), h('td', {}, t.direction === 'out' ? t.toName : t.fromName),
        h('td', {}, `${t.lineCount} produit(s) · ${t.units} unité(s)`), h('td', {}, trBadge(t.status)), h('td', {}, UI.fmtDateTime(t.sentAt || t.createdAt)),
        h('td', {}, h('button', { class: 'btn sm', onclick: () => transferDetail(t.id, load) }, 'Ouvrir')))), 'Aucun transfert pour le moment.'));
    } catch (e) { holder.replaceChildren(h('div', { class: 'form-error' }, e.message)); }
  }
  content.replaceChildren(pageHead('Transferts de stock', canT && h('button', { class: 'btn primary', onclick: () => transferForm(load) }, 'Nouveau transfert')),
    h('div', { class: 'info-box' }, 'Un transfert se fait en deux temps : la pharmacie expéditrice expédie (le stock sort, dans l’ordre de péremption), la pharmacie destinataire réceptionne (mêmes numéros de lot et péremptions). Les produits à registre (stupéfiants) ne sont pas transférables ici.'),
    h('div', { class: 'toolbar' }, sel), holder);
  await load();
}

async function transferForm(done) {
  let sites;
  try { sites = (await Api.get('/api/transferts/sites')).sites; } catch (e) { return toast(e.message, true); }
  if (!sites.length) return toast('Aucune autre pharmacie de votre groupe ne peut recevoir de stock (module Stocks actif requis).', true);
  const err = errBox();
  const dest = h('select', {}, sites.map((s) => h('option', { value: s.id }, `${s.name}${s.city ? ` — ${s.city}` : ''}`)));
  const notes = h('input', { type: 'text', maxlength: '300', placeholder: 'Facultatif' });
  const lines = new Map();
  const list = h('div'); const results = h('div', { class: 'chips' });
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher un produit à transférer (2 lettres minimum)', 'aria-label': 'Rechercher un produit' });
  const renderLines = () => list.replaceChildren(lines.size
    ? table(['Produit', 'Disponible', 'Quantité à transférer', ''], [...lines.entries()].map(([id, l]) => h('tr', {}, h('td', {}, l.name), h('td', { class: 'num' }, String(l.available)),
      h('td', {}, h('input', { type: 'number', min: '1', max: String(l.available), step: '1', value: String(l.qty), style: 'width:6rem', oninput: (e) => { l.qty = parseInt(e.target.value, 10) || 0; } })),
      h('td', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => { lines.delete(id); renderLines(); } }, 'Retirer')))), '')
    : h('p', { class: 'muted small' }, 'Aucun produit ajouté.'));
  let tm;
  q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(async () => {
    if (q.value.trim().length < 2) return results.replaceChildren();
    try {
      const { products } = await Api.get(`/api/stocks/products?q=${encodeURIComponent(q.value.trim())}`);
      results.replaceChildren(...products.filter((p) => p.available > 0 && !p.isControlled).slice(0, 8).map((p) => h('button', { class: 'btn sm', type: 'button', onclick: () => { if (!lines.has(p.id)) lines.set(p.id, { name: p.name, available: p.available, qty: 1 }); renderLines(); } }, `${p.name} (${p.available})`)));
    } catch { /* la recherche reste vide */ }
  }, 300); });
  renderLines();
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Créer le brouillon');
  const form = h('form', { novalidate: true }, err, field('Pharmacie destinataire', dest), field('Note', notes),
    h('strong', {}, 'Produits'), q, results, list,
    h('p', { class: 'small muted' }, 'Le stock n’est ni réservé ni déplacé avant l’expédition. Vérifiez le brouillon, puis expédiez-le.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), save));
  const m = modal('Nouveau transfert', form, { wide: true });
  form.onsubmit = (e) => { e.preventDefault(); busy(save, async () => {
    try {
      const body = { toTenantId: dest.value, notes: notes.value, lines: [...lines.entries()].map(([productId, l]) => ({ productId, quantity: l.qty })) };
      if (!body.lines.length || body.lines.some((l) => !(l.quantity >= 1))) throw new Error('Ajoutez au moins un produit, avec une quantité d’au moins 1.');
      const r = await Api.post('/api/transferts', body);
      m.close(); toast(`Brouillon ${r.transfer.number} créé`); done(); transferDetail(r.transfer.id, done);
    } catch (x) { showErr(err, x); }
  }); };
}

async function transferDetail(id, reload) {
  let d;
  try { d = await Api.get(`/api/transferts/${id}`); } catch (e) { return toast(e.message, true); }
  const { transfer: t, lines, lots } = d; const out = t.direction === 'out'; const canT = me.permissions.includes('stocks:transfer');
  const act = (label, call, cls, confirmMsg, okMsg, bodyFn) => h('button', { class: `btn ${cls}`, type: 'button', onclick: (e) => {
    const msg = typeof confirmMsg === 'function' ? confirmMsg() : confirmMsg;       // une fonction peut annuler (null) après avoir signalé l'erreur
    if (msg === null) return;
    if (msg && !window.confirm(msg)) return;
    const body = bodyFn ? bodyFn() : {}; if (body === null) return;
    busy(e.currentTarget, async () => {
      try { const r = await call(body); m.close(); toast(`${okMsg}${r.shortfall ? ` avec un écart de ${r.shortfall} unité(s)` : ''}${r.createdProducts ? ` (${r.createdProducts} produit(s) ajouté(s) à votre catalogue)` : ''}`); reload(); } catch (x) { toast(x.message, true); }
    });
  } }, label);
  const inputs = new Map();                                                          // quantités reçues, lot par lot (réception)
  const receiving = canT && !out && t.status === 'in_transit';
  const readReceived = () => {
    const received = {}; let total = 0; let short = 0;
    for (const l of lots) {
      const inp = inputs.get(l.id); const n = Number(inp.value);
      if (inp.value === '' || !Number.isInteger(n) || n < 0 || n > l.quantity) { toast(`Quantité invalide pour le lot ${l.lotNumber} (0 à ${l.quantity})`, true); return null; }
      received[l.id] = n; total += n; short += l.quantity - n;
    }
    if (total === 0) { toast('Rien n’est reçu : utilisez « Refuser » avec un motif.', true); return null; }
    return { received, short };
  };
  const actions = [];
  if (canT && out && t.status === 'draft') actions.push(act('Expédier', (b) => Api.post(`/api/transferts/${id}/send`, b), 'primary', `Expédier ${t.number} à ${t.toName} ? Le stock sort immédiatement de votre pharmacie.`, 'Transfert expédié'), act('Annuler le brouillon', (b) => Api.post(`/api/transferts/${id}/cancel`, b), '', null, 'Brouillon annulé'));
  if (canT && out && t.status === 'in_transit') actions.push(act('Annuler l’envoi', (b) => Api.post(`/api/transferts/${id}/cancel`, b), '', `Annuler ${t.number} ? Le stock expédié revient sur vos lots d’origine.`, 'Envoi annulé, stock repris'));
  if (canT && out && t.status === 'refused') actions.push(act('Reprendre le stock', (b) => Api.post(`/api/transferts/${id}/return`, b), 'primary', 'Remettre en stock les quantités refusées, sur leurs lots d’origine ?', 'Stock repris'));
  if (canT && out && t.status === 'received_short') actions.push(act(`Reprendre l’écart (${t.shortfallUnits} unité(s))`, (b) => Api.post(`/api/transferts/${id}/return`, b), 'primary', `Remettre en stock les ${t.shortfallUnits} unité(s) manquantes à la réception, sur leurs lots d’origine ?`, 'Écart repris'));
  if (canT && !out && t.status === 'in_transit') actions.push(
    act('Réceptionner', (b) => Api.post(`/api/transferts/${id}/receive`, b), 'success',
      () => { const r = readReceived(); if (!r) return null; return r.short > 0 ? `Réceptionner ${t.number} avec un écart de ${r.short} unité(s) ? Les quantités reçues entrent dans votre stock ; l’écart reste en transit jusqu’à sa reprise par l’expéditeur.` : `Réceptionner ${t.number} ? Les lots entrent dans votre stock avec leurs péremptions.`; },
      'Transfert reçu', () => { const r = readReceived(); return r ? { received: r.received } : null; }),
    act('Refuser', (b) => Api.post(`/api/transferts/${id}/refuse`, b), '', null, 'Transfert refusé', () => { const r = window.prompt('Motif du refus (obligatoire)'); return r && r.trim() ? { reason: r.trim() } : null; }));
  const showRecv = receiving || lots.some((l) => l.receivedQuantity != null);
  const lotRows = lots.map((l) => {
    const cells = [h('td', {}, (lines.find((x) => x.id === l.lineId) || {}).productName || '—'), h('td', {}, l.lotNumber), h('td', {}, UI.fmtDate(l.expiryDate)), h('td', { class: 'num' }, String(l.quantity))];
    if (receiving) {
      const inp = h('input', { type: 'number', min: '0', max: String(l.quantity), step: '1', value: String(l.quantity), style: 'width:5.5rem', 'aria-label': `Quantité reçue du lot ${l.lotNumber}` });
      inputs.set(l.id, inp); cells.push(h('td', {}, inp));
    } else if (l.receivedQuantity != null) cells.push(h('td', { class: 'num' }, l.receivedQuantity < l.quantity ? `${l.receivedQuantity} (écart ${l.quantity - l.receivedQuantity})` : String(l.receivedQuantity)));
    return h('tr', {}, ...cells);
  });
  const body = h('div', {},
    h('dl', { class: 'kv' }, h('dt', {}, 'Statut'), h('dd', {}, trBadge(t.status)), h('dt', {}, out ? 'Destinataire' : 'Expéditeur'), h('dd', {}, out ? t.toName : t.fromName),
      ...(t.notes ? [h('dt', {}, 'Note'), h('dd', {}, t.notes)] : []), ...(t.refusalReason ? [h('dt', {}, 'Motif du refus'), h('dd', {}, t.refusalReason)] : []),
      h('dt', {}, 'Expédié le'), h('dd', {}, UI.fmtDateTime(t.sentAt)), ...(t.receivedAt ? [h('dt', {}, 'Reçu le'), h('dd', {}, UI.fmtDateTime(t.receivedAt))] : [])),
    h('strong', {}, 'Produits'),
    table(['Produit', 'Forme / dosage', 'Quantité', ''], lines.map((l) => h('tr', {}, h('td', {}, l.productName), h('td', {}, [l.form, l.dosage].filter(Boolean).join(' ') || '—'), h('td', { class: 'num' }, String(l.quantity)),
      h('td', {}, l.createdProduct ? h('span', { class: 'badge' }, 'Ajouté au catalogue') : ''))), ''),
    lots.length > 0 && h('div', {}, h('br'), h('strong', {}, 'Lots expédiés'), table(showRecv ? ['Produit', 'Lot', 'Péremption', 'Expédié', 'Reçu'] : ['Produit', 'Lot', 'Péremption', 'Quantité'], lotRows, '')),
    receiving && h('p', { class: 'small muted' }, 'Indiquez, lot par lot, la quantité réellement reçue : un écart reste en transit jusqu’à sa reprise par l’expéditeur. Si rien ne correspond, refusez le transfert avec un motif.'),
    t.status === 'received_short' && h('p', { class: 'small muted' }, out ? 'Le destinataire a reçu moins que prévu : reprenez l’écart pour le remettre en stock sur vos lots d’origine.' : 'Écart constaté à la réception : il reste en transit jusqu’à sa reprise par l’expéditeur.'),
    h('div', { class: 'actions' }, ...actions, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Fermer')));
  const m = modal(`${t.number} — ${out ? `vers ${t.toName}` : `de ${t.fromName}`}`, body, { wide: true });
}

/** Transferts récents du groupe, sous la vue consolidée (lecture seule). */
async function groupTransfersCard() {
  try {
    const { transfers } = await Api.get('/api/groupe/transfers');
    return h('div', { class: 'card' }, h('strong', {}, 'Transferts de stock récents'),
      table(['N°', 'De', 'Vers', 'Contenu', 'Statut', 'Date'], transfers.slice(0, 15).map((t) => h('tr', {}, h('td', {}, t.number), h('td', {}, t.fromName), h('td', {}, t.toName),
        h('td', {}, `${t.lineCount} produit(s) · ${t.units} unité(s)`), h('td', {}, trBadge(t.status)), h('td', {}, UI.fmtDateTime(t.sentAt || t.createdAt)))), 'Aucun transfert.'));
  } catch { return false; }
}

/* ================= Démarrage ================= */
async function logout() { await Api.logout(); me = null; renderLogin(); }
Api.onLogout(() => { me = null; renderLogin(); });

/** Charge le profil ; si la pharmacie de travail mémorisée n'est plus accessible, retour à la pharmacie de l'utilisateur. */
async function loadMe() {
  try { me = (await Api.get('/api/auth/me')).user; }
  catch (e) {
    if (Api.getSite() && (e.code === 'SITE_FORBIDDEN' || e.code === 'SUBSCRIPTION_INACTIVE')) { Api.setSite(null); me = (await Api.get('/api/auth/me')).user; } else throw e;
  }
  UI.setTimezone(me.timezone);
  groupSites = [];
  if (me.isGroupAdmin) { try { groupSites = (await Api.get('/api/groupe/sites')).sites; } catch { /* le sélecteur reste simplement masqué */ } }
}

/** Travailler dans une autre pharmacie du groupe (ou revenir à la sienne) : droits, modules et fuseau sont rechargés. */
async function switchSite(id) {
  Api.setSite(id && id !== me.homeTenantId ? id : null);
  try { await loadMe(); } catch (e) { toast(e.message, true); }
  view = 'dashboard'; await render();
}

async function boot() {
  if (!Api.hasSession()) return renderLogin();
  try { await loadMe(); } catch (e) { Api.clear(); return renderLogin(); }
  if (me.mustChangePassword) return renderForcedPassword();
  view = 'dashboard'; await render();
}
boot();
