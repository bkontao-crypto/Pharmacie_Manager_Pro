// Faux serveur : sert /frontend et simule l'API (état en mémoire) — pour tester l'interface dans un vrai navigateur, sans PostgreSQL.
// Les réponses simulées reprennent la forme réelle de l'API (snake_case pour les comptes et pharmacies Superadmin, camelCase ailleurs).
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'frontend');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };
const MAIN = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222', B = '33333333-3333-4333-8333-333333333333';
const ALLM = ['patients', 'dispensation', 'stocks', 'achats', 'ventes', 'rapports', 'rh', 'crm', 'conformite', 'integrations'];
const perms = (mods, extra = []) => [...mods.flatMap((m) => [`${m}:read`, `${m}:write`]), ...extra];
const state = { role: 'groupadmin', granted: false, calls: [], trStatus: 'in_transit', created: [], received: null };
const baseUser = { id: 'u1', fullName: 'Awa Traoré', email: 'awa@test.ml', mustChangePassword: false, timezone: 'Africa/Bamako', totpEnabled: false };
function me(siteHeader) {
  if (state.role === 'superadmin') return { ...baseUser, role: 'superadmin', tenantId: null, permissions: [], enabledModules: [] };
  if (state.role === 'gerant') return { ...baseUser, role: 'gerant', tenantId: A, homeTenantId: A, tenantName: 'Sous A', inGroup: true, isSubsite: true, isGroupAdmin: false, acting: false,
    enabledModules: ALLM, permissions: [...perms(ALLM), 'users:read', 'users:write', 'stocks:adjust', 'stocks:transfer'] };
  const acting = siteHeader && siteHeader !== MAIN; const mods = acting ? ALLM.filter((m) => !['patients', 'dispensation', 'crm'].includes(m) || state.granted) : ALLM;
  return { ...baseUser, role: 'admin', homeTenantId: MAIN, homeTenantName: 'Pharmacie Centrale', tenantId: acting ? siteHeader : MAIN, tenantName: acting ? 'Sous A' : 'Pharmacie Centrale',
    inGroup: true, isGroupAdmin: true, isSubsite: !!acting, acting: !!acting, patientDataRestricted: !!acting && !state.granted, groupMaxSites: 3,
    enabledModules: mods, permissions: [...perms(mods), 'users:read', 'users:write', 'audit:read', 'stocks:adjust', 'stocks:transfer'] };
}
const kpi = (r, n) => ({ revenue: r, salesCount: n, avgBasket: Math.round(r / n), margin: Math.round(r * 0.3), marginPct: 30, discounts: 1200, refunded: 0, distinctPatients: 12 });
const T = (id, no, st, dir, o = {}) => ({ id, number: no, status: st, direction: dir, fromId: dir === 'out' ? A : MAIN, fromName: dir === 'out' ? 'Sous A' : 'Pharmacie Centrale', toId: dir === 'out' ? B : A, toName: dir === 'out' ? 'Sous B' : 'Sous A', notes: 'Réassort', refusalReason: null, createdAt: '2026-11-18T10:00:00Z', sentAt: '2026-11-18T11:00:00Z', receivedAt: null, lineCount: 2, units: 25, ...o });
function api(req, url, body) {
  const site = req.headers['x-pharmacy-id']; state.calls.push(`${req.method} ${url}${site ? ` [site ${site.slice(0, 2)}]` : ''}`);
  const p = url.split('?')[0];
  if (p === '/api/rh/clock') return site && site !== MAIN && state.role === 'groupadmin' ? { __status: 403, error: 'Le pointage se fait dans votre propre pharmacie', code: 'CLOCK_ACTING' } : { open: null, clockIn: null };
  if (p === '/api/auth/me') return { user: me(site) };
  if (p === '/api/groupe/sites') return { group: { maxSites: 3, used: 2, remaining: 1 }, sites: [
    { id: MAIN, name: 'Pharmacie Centrale', city: 'Bamako', timezone: 'Africa/Bamako', status: 'active', isMain: true, patientAccess: true, modules: ALLM, userCount: 5, manager: null },
    { id: A, name: 'Sous A', city: 'Kati', timezone: 'Africa/Bamako', status: 'active', isMain: false, patientAccess: state.granted, modules: ALLM, userCount: 3, manager: { fullName: 'Moussa Keita', email: 'moussa@test.ml', isActive: true } },
    { id: B, name: 'Sous B', city: 'Ségou', timezone: 'Africa/Douala', status: 'active', isMain: false, patientAccess: false, modules: ['stocks'], userCount: 1, manager: null }] };
  if (p === '/api/groupe/overview') return { period: { from: '2026-10-20', to: '2026-11-19' }, sites: [
    { id: MAIN, name: 'Pharmacie Centrale', isMain: true, timezone: 'Africa/Bamako', kpis: kpi(1500000, 120), stockValuation: { value: 9000000, expiredValue: 45000, units: 4000 } },
    { id: A, name: 'Sous A', isMain: false, timezone: 'Africa/Bamako', kpis: kpi(800000, 70), stockValuation: { value: 4000000, expiredValue: 0, units: 2000 } }],
    skipped: [{ id: B, name: 'Sous B', reason: 'Module « Rapports & Pilotage » non activé' }],
    totals: { revenue: 2300000, salesCount: 190, margin: 690000, marginPct: 30, avgBasket: 12105, discounts: 2400, refunded: 0, stockValue: 13000000, expiredValue: 45000 } };
  if (p === '/api/groupe/transfers') return { transfers: [{ id: 't1', number: 'TRF-000001', status: 'received', fromName: 'Sous A', toName: 'Sous B', lineCount: 2, units: 25, createdAt: '2026-11-18T10:00:00Z', sentAt: '2026-11-18T11:00:00Z' }] };
  if (p === '/api/site/patient-access') { if (req.method === 'PUT') { state.granted = !!body.granted; return { granted: state.granted }; } return { granted: state.granted, groupName: 'Pharmacie Centrale' }; }
  if (p === '/api/transferts/sites') return { sites: [{ id: MAIN, name: 'Pharmacie Centrale', city: 'Bamako', isMain: true }, { id: B, name: 'Sous B', city: 'Ségou', isMain: false }] };
  if (p === '/api/transferts' && req.method === 'POST') { state.created.push(body); return { transfer: { id: 't9', number: 'TRF-000009' } }; }
  if (p === '/api/transferts') return { transfers: [T('t2', 'TRF-000002', state.trStatus, 'in'), T('t3', 'TRF-000003', 'draft', 'out', { sentAt: null }), T('t4', 'TRF-000004', 'refused', 'out', { refusalReason: 'Lot endommagé' }), T('t5', 'TRF-000005', 'received_short', 'out', { shortfallUnits: 7, receivedAt: '2026-11-19T09:00:00Z' })] };
  let m = p.match(/^\/api\/transferts\/(t\d)\/(\w+)$/); if (m) { state.calls.push(`ACTION ${m[2]}`); if (m[2] === 'receive') { state.trStatus = 'received'; state.received = body; return { ok: true, createdProducts: 1, shortfall: 7 }; } return { ok: true }; }
  m = p.match(/^\/api\/transferts\/(t\d)$/);
  if (m) { const st = m[1] === 't9' ? 'draft' : m[1] === 't3' ? 'draft' : m[1] === 't4' ? 'refused' : m[1] === 't5' ? 'received_short' : state.trStatus; const dir = ['t3', 't4', 't5', 't9'].includes(m[1]) ? 'out' : 'in';
    return { transfer: T(m[1], 'TRF-00000' + m[1].slice(1), st, dir, { refusalReason: st === 'refused' ? 'Lot endommagé' : null, sentAt: st === 'draft' ? null : '2026-11-18T11:00:00Z', shortfallUnits: st === 'received_short' ? 7 : 0 }),
      lines: [{ id: 'l1', productName: 'Paracétamol 500 mg', dci: 'paracétamol', form: 'Comprimé', dosage: '500 mg', quantity: 15, createdProduct: st === 'received' }, { id: 'l2', productName: 'Amoxicilline 1 g', dci: null, form: 'Gélule', dosage: '1 g', quantity: 10, createdProduct: false }],
      lots: st === 'draft' ? [] : [{ id: 'k1', lineId: 'l1', lotNumber: 'L1', expiryDate: '2027-01-31', quantity: 10, receivedQuantity: st === 'received_short' ? 3 : null }, { id: 'k2', lineId: 'l1', lotNumber: 'L2', expiryDate: '2027-06-30', quantity: 5, receivedQuantity: st === 'received_short' ? 5 : null }, { id: 'k3', lineId: 'l2', lotNumber: 'A9', expiryDate: '2027-03-31', quantity: 10, receivedQuantity: st === 'received_short' ? 2 : null }] }; }
  if (p === '/api/stocks/products') return { products: [{ id: 'p1', name: 'Paracétamol 500 mg', available: 30, isControlled: false }, { id: 'p2', name: 'Morphine 10 mg', available: 5, isControlled: true }, { id: 'p3', name: 'Rupture X', available: 0, isControlled: false }] };
  if (p === '/api/users/catalog') return { roles: [{ key: 'gerant', label: 'Gérant local' }, { key: 'pharmacien', label: 'Pharmacien' }, { key: 'caissier', label: 'Caissier' }], modules: [], permissions: [] };
  if (p === '/api/users') return { users: [{ id: 'u1', full_name: 'Awa Traoré', email: 'awa@test.ml', role: 'admin', is_active: true, effectivePermissions: [], last_login_at: null }, { id: 'u2', full_name: 'Moussa Keita', email: 'moussa@test.ml', role: 'gerant', is_active: true, effectivePermissions: ['a'], last_login_at: null }, { id: 'u3', full_name: 'Fanta Sow', email: 'fanta@test.ml', role: 'caissier', is_active: true, effectivePermissions: ['a', 'b'], last_login_at: '2026-11-18T08:00:00Z' }] };
  if (p === '/api/superadmin/tenants') return { tenants: [
    { id: B, name: 'Sous B', slug: 'sous-b', city: 'Ségou', plan: 'standard', status: 'active', timezone: 'Africa/Douala', parent_id: MAIN, max_subsites: 0, site_count: 0, group_patient_access: false, admin_count: 0, user_count: 1, subscription_end: null, modules: ['stocks'] },
    { id: MAIN, name: 'Pharmacie Centrale', slug: 'centrale', city: 'Bamako', plan: 'standard', status: 'active', timezone: 'Africa/Bamako', parent_id: null, max_subsites: 3, site_count: 2, group_patient_access: false, admin_count: 1, user_count: 5, subscription_end: '2027-12-31', modules: ALLM },
    { id: A, name: 'Sous A', slug: 'sous-a', city: 'Kati', plan: 'standard', status: 'active', timezone: 'Africa/Bamako', parent_id: MAIN, max_subsites: 0, site_count: 0, group_patient_access: false, admin_count: 0, user_count: 3, subscription_end: null, modules: ALLM }] };
  if (/^\/api\/superadmin\/tenants\/[^/]+\/admin$/.test(p)) return { admin: p.includes(MAIN) ? { id: 'ua', fullName: 'Awa Traoré', email: 'awa@test.ml', is_active: true } : null };
  if (/^\/api\/superadmin\/tenants\/[^/]+\/modules$/.test(p)) return { modules: ALLM };
  if (p === '/api/superadmin/modules' || p === '/api/modules') return { modules: ALLM.map((k, i) => ({ key: k, label: k, description: '', is_core: false, sort_order: i })) };
  if (p === '/api/superadmin/dashboard') return { stats: { tenants: 3, active: 3, users: 9 }, recent: [] };
  return {};
}
http.createServer((req, res) => {
  const url = req.url;
  if (url.startsWith('/api/')) { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { let body = {}; try { body = b ? JSON.parse(b) : {}; } catch {} const out = api(req, url, body); res.statusCode = (out && out.__status) || 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out)); }); return; }
  if (url === '/__state') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(state)); }
  if (url.startsWith('/__role/')) { state.role = url.slice(8); state.granted = false; state.trStatus = 'in_transit'; state.calls = []; state.created = []; state.received = null; return res.end('ok'); }
  let f = path.join(ROOT, url === '/' ? 'index.html' : url.split('?')[0]);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(8099, () => console.log('mock sur 8099'));
