'use strict';
/**
 * Tests d'INTÉGRATION : serveur réel + PostgreSQL réel. Désactivés sans base de test.
 *
 *   TEST_DATABASE_URL=postgresql://pmp_app:…@localhost:5432/pharmacie_test \
 *   TEST_MIGRATE_DATABASE_URL=postgresql://pmp_owner:…@localhost:5432/pharmacie_test \
 *   npm run test:integration
 *
 * ⚠ Utiliser une base DÉDIÉE aux tests (jamais la production). TEST_DATABASE_URL doit être un rôle NON superuser
 *   et NON BYPASSRLS (sinon l'isolation entre pharmacies ne peut pas être vérifiée). Chaque exécution crée ses propres
 *   pharmacies avec un suffixe aléatoire : la base n'a pas besoin d'être vidée entre deux exécutions.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const TEST_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_URL ? false : 'TEST_DATABASE_URL non défini : tests d\'intégration ignorés';
const RUN = crypto.randomBytes(3).toString('hex');
const PWD = 'Initial12345x'; const PWD2 = 'Definitif12345x';
const MODULES = ['patients', 'stocks', 'dispensation', 'achats', 'ventes', 'rapports', 'conformite', 'integrations', 'crm', 'rh'];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let base; let server; let tx; let pool; const S = {};

const api = async (method, path, body, token, extra = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* non JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, `HTTP ${r.status} au lieu de ${status} : ${r.text.slice(0, 400)}`); return r.body; };
const fail = (r, status, code) => { assert.equal(r.status, status, `HTTP ${r.status} au lieu de ${status} : ${r.text.slice(0, 400)}`); if (code) assert.equal(r.body?.code, code, `code ${r.body?.code} au lieu de ${code}`); return r.body; };

/** Connecte un compte ; si un changement de mot de passe est exigé, le fait puis se reconnecte. Retourne le jeton d'accès. */
async function activate(email, pwd = PWD) {
  let b = ok(await api('POST', '/api/auth/login', { email, password: pwd }));
  if (b.user.mustChangePassword) {
    ok(await api('POST', '/api/auth/change-password', { currentPassword: pwd, newPassword: PWD2 }, b.accessToken));
    b = ok(await api('POST', '/api/auth/login', { email, password: PWD2 }));
  }
  return b.accessToken;
}
async function newTenant(label, modules = MODULES) {
  const t = ok(await api('POST', '/api/superadmin/tenants', { name: `Pharmacie ${label} ${RUN}`, modules }, S.sa), 201).tenant;
  const email = `admin-${label.toLowerCase()}-${RUN}@test.ml`;
  ok(await api('POST', `/api/superadmin/tenants/${t.id}/admin`, { fullName: `Admin ${label}`, email, password: PWD }, S.sa), 201);
  return { id: t.id, email };
}
const lotsOf = async (productId) => Object.fromEntries(ok(await api('GET', `/api/stocks/products/${productId}`, undefined, S.admin)).lots.map((l) => [l.lot_number, l.quantity]));
const newProduct = async (name, extra = {}) => ok(await api('POST', '/api/stocks/products', { name: `${name} ${RUN}`, salePrice: 1000, purchasePrice: 600, ...extra }, S.admin), 201).product;
const receive = (productId, lotNumber, quantity, days = 120) => api('POST', '/api/stocks/receive', { productId, lotNumber, expiryDate: day(days), quantity }, S.admin);

describe('Pharmacie Manager Pro — intégration PostgreSQL', { skip }, () => {
  before(async () => {
    Object.assign(process.env, { DATABASE_URL: TEST_URL, JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'ab'.repeat(32), NODE_ENV: 'test', LOGIN_RATE_MAX: '500', API_RATE_MAX: '5000' });
    const mig = require('../../scripts/migrate');
    await mig.run(process.env.TEST_MIGRATE_DATABASE_URL || TEST_URL);
    await mig.run(process.env.TEST_MIGRATE_DATABASE_URL || TEST_URL);   // la migration doit être idempotente
    ({ tx, pool } = require('../../src/db'));
    const { createApp } = require('../../src/app');
    await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } if (pool) await pool.end(); });

  describe('Prérequis et sécurité de base', () => {
    it('le rôle applicatif n\'est ni superuser ni BYPASSRLS (sinon la RLS serait contournée)', async () => {
      const r = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      assert.ok(!r.rolsuper && !r.rolbypassrls, 'TEST_DATABASE_URL doit utiliser un rôle non superuser et non BYPASSRLS');
    });
    it('santé, authentification obligatoire, mauvais mot de passe', async () => {
      assert.equal(ok(await api('GET', '/api/health')).status, 'OK');
      fail(await api('GET', '/api/users'), 401);
      fail(await api('POST', '/api/auth/login', { email: 'inconnu@test.ml', password: 'Nimportequoi123' }), 401);
    });
    it('corps de requête : 100 Ko max partout (413), mais les imports acceptent jusqu\'à 3 Mo', async () => {
      assert.equal((await api('POST', '/api/auth/login', { email: 'a@b.cd', password: 'x'.repeat(200000) })).status, 413);
    });
    it('Superadmin de test + connexion', async () => {
      const bcrypt = require('bcryptjs'); S.saEmail = `sa-${RUN}@test.ml`;
      await tx({ system: true }, async (c) => c.query(`INSERT INTO users (tenant_id, email, full_name, role, password_hash, must_change_password) VALUES (NULL,$1,'SA Test','superadmin',$2,false)`, [S.saEmail, await bcrypt.hash(PWD, 10)]));
      S.sa = ok(await api('POST', '/api/auth/login', { email: S.saEmail, password: PWD })).accessToken;
      fail(await api('GET', '/api/users', undefined, S.sa), 403);
    });
  });

  describe('Pharmacies, modules, abonnement, comptes', () => {
    it('création des pharmacies A et B, premier Admin unique, changement de mot de passe forcé', async () => {
      S.A = await newTenant('A'); S.B = await newTenant('B');
      fail(await api('POST', `/api/superadmin/tenants/${S.A.id}/admin`, { fullName: 'Doublon', email: `x-${RUN}@test.ml`, password: PWD }, S.sa), 409);
      const b = ok(await api('POST', '/api/auth/login', { email: S.A.email, password: PWD }));
      assert.equal(b.user.mustChangePassword, true);
      fail(await api('GET', '/api/users', undefined, b.accessToken), 403, 'MUST_CHANGE_PASSWORD');
      S.admin = await activate(S.A.email); S.adminB = await activate(S.B.email);
      assert.ok(ok(await api('GET', '/api/users', undefined, S.admin)).users.length >= 1);
    });
    it('un module non activé retire les droits ; une pharmacie suspendue est bloquée', async () => {
      const C = await newTenant('C', ['stocks']); const tc = await activate(C.email);
      fail(await api('GET', '/api/patients', undefined, tc), 403);
      ok(await api('GET', '/api/stocks/products', undefined, tc));
      fail(await api('POST', '/api/users', { email: `rh-${RUN}@test.ml`, fullName: 'RH', role: 'personnalise', permissions: ['rh:read'], password: PWD }, tc), 403);   // l'Admin ne peut pas accorder un droit d'un module non activé
      ok(await api('PATCH', `/api/superadmin/tenants/${C.id}`, { status: 'suspended' }, S.sa));
      fail(await api('GET', '/api/stocks/products', undefined, tc), 403, 'SUBSCRIPTION_INACTIVE');
    });
    it('employés : droits limités à l\'Admin et aux modules activés', async () => {
      const email = `caisse-${RUN}@test.ml`; ok(await api('POST', '/api/users', { email, fullName: 'Caissier', role: 'caissier', password: PWD }, S.admin), 201);
      S.cashier = await activate(email);
      fail(await api('POST', '/api/patients', { lastName: 'X', firstName: 'Y' }, S.cashier), 403);
      ok(await api('GET', '/api/patients', undefined, S.cashier));
      fail(await api('GET', '/api/rapports/overview', undefined, S.cashier), 403);
    });
  });

  describe('Stocks et caisse', () => {
    it('réception de lots : péremption passée refusée, même lot avec autre date refusé', async () => {
      S.P1 = await newProduct('Ibuprofène 400', { dci: 'Ibuprofène', dosage: '400 mg', form: 'comprimé', minStock: 10, maxStock: 100 });
      ok(await receive(S.P1.id, 'LA', 5, 120), 201); ok(await receive(S.P1.id, 'LB', 5, 30), 201);
      assert.equal((await api('POST', '/api/stocks/receive', { productId: S.P1.id, lotNumber: 'LX', expiryDate: day(-1), quantity: 1 }, S.admin)).status, 400);
      assert.equal((await api('POST', '/api/stocks/receive', { productId: S.P1.id, lotNumber: 'LB', expiryDate: day(300), quantity: 1 }, S.admin)).status, 409);
    });
    it('vente comptoir : sortie FEFO (lot qui périme en premier), paiements exacts, stock jamais négatif', async () => {
      const pay = (n) => [{ method: 'especes', amount: n }];
      const s = ok(await api('POST', '/api/ventes/sales', { items: [{ productId: S.P1.id, quantity: 3 }], payments: pay(3000) }, S.cashier), 201);
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 2 });
      fail(await api('POST', '/api/ventes/sales', { items: [{ productId: S.P1.id, quantity: 1 }], payments: pay(999) }, S.cashier), 409, 'PAYMENT_MISMATCH');
      fail(await api('POST', '/api/ventes/sales', { items: [{ productId: S.P1.id, quantity: 999 }], payments: pay(999000) }, S.cashier), 409, 'INSUFFICIENT_STOCK');
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 2 });
      fail(await api('POST', `/api/ventes/sales/${s.id}/refund`, { reason: 'erreur de saisie' }, S.cashier), 403);   // le caissier n'a pas ventes:refund
      ok(await api('POST', `/api/ventes/sales/${s.id}/refund`, { reason: 'erreur de saisie' }, S.admin));
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 5 });                                                   // remis sur le lot d'origine
      fail(await api('POST', `/api/ventes/sales/${s.id}/refund`, { reason: 'encore' }, S.admin), 409);
    });
    it('remise : total net, produit sur ordonnance refusé au comptoir', async () => {
      const s = ok(await api('POST', '/api/ventes/sales', { items: [{ productId: S.P1.id, quantity: 2 }], discountPct: 10, payments: [{ method: 'mobile_money', amount: 1800 }] }, S.cashier), 201);
      assert.equal(ok(await api('GET', `/api/ventes/sales/${s.id}`, undefined, S.admin)).sale.total, 1800);
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 3 });
      const rx = await newProduct('Morphine Rx', { requiresPrescription: true });
      fail(await api('POST', '/api/ventes/sales', { items: [{ productId: rx.id, quantity: 1 }], payments: [{ method: 'especes', amount: 1000 }] }, S.cashier), 409, 'PRESCRIPTION_REQUIRED');
    });
    it('CONCURRENCE : deux ventes simultanées de la dernière unité → une seule réussit', async () => {
      const P2 = await newProduct('Dernière unité'); ok(await receive(P2.id, 'R1', 1), 201);
      const body = { items: [{ productId: P2.id, quantity: 1 }], payments: [{ method: 'especes', amount: 1000 }] };
      const res = await Promise.all([api('POST', '/api/ventes/sales', body, S.cashier), api('POST', '/api/ventes/sales', body, S.cashier)]);
      assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], res.map((r) => r.text.slice(0, 120)).join(' | '));
      assert.deepEqual(await lotsOf(P2.id), { R1: 0 });
    });
  });

  describe('Patients et dispensation', () => {
    it('dossier patient : champs sensibles chiffrés au repos, lisibles via l\'API, consultation tracée', async () => {
      S.patLast = `Traore${RUN}`;
      S.pat = ok(await api('POST', '/api/patients', { lastName: S.patLast, firstName: 'Awa', birthDate: '1990-05-12', allergies: ['ibuprofène'], insuranceNumber: 'SECRET-123', notes: 'note confidentielle' }, S.admin), 201).patient;
      const raw = await tx({ system: true }, async (c) => (await c.query('SELECT insurance_number_enc, notes_enc FROM patients WHERE id = $1', [S.pat.id])).rows[0]);
      assert.ok(raw.insurance_number_enc.startsWith('v1:') && !raw.insurance_number_enc.includes('SECRET'));
      assert.ok(raw.notes_enc.startsWith('v1:') && !raw.notes_enc.includes('confidentielle'));
      assert.equal(ok(await api('GET', `/api/patients/${S.pat.id}`, undefined, S.admin)).patient.insuranceNumber, 'SECRET-123');
      const n = await tx({ system: true }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'patient.viewed' AND entity_id = $1`, [S.pat.id])).rows[0].n);
      assert.ok(n >= 1);
    });
    it('ordonnance : alerte d\'allergie, validation avec justification écrite, délivrance FEFO, pas de double délivrance', async () => {
      const rx = ok(await api('POST', '/api/dispensation/prescriptions', { patientId: S.pat.id, prescriberName: 'Dr Test', prescribedOn: day(0), items: [{ productId: S.P1.id, quantity: 2, posology: '1 comprimé 3 fois par jour' }] }, S.admin), 201);
      assert.ok(rx.alerts.some((a) => a.type === 'allergy' && a.level === 'danger'));
      S.rx1 = rx.id;
      const v = `/api/dispensation/prescriptions/${rx.id}/validate`;
      const a1 = fail(await api('POST', v, {}, S.admin), 409, 'ALERTS_REQUIRE_ACK'); assert.equal(a1.requiresNote, true);
      fail(await api('POST', v, { acknowledgeAlerts: true }, S.admin), 409, 'NOTE_REQUIRED');
      ok(await api('POST', v, { acknowledgeAlerts: true, note: 'Bénéfice/risque discuté avec le prescripteur' }, S.admin));
      ok(await api('POST', `/api/dispensation/prescriptions/${rx.id}/dispense`, {}, S.admin));
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 1 });                                                  // LB (péremption proche) consommé en premier
      fail(await api('POST', `/api/dispensation/prescriptions/${rx.id}/dispense`, {}, S.admin), 409);
      fail(await api('POST', `/api/dispensation/prescriptions/${rx.id}/cancel`, { reason: 'trop tard' }, S.admin), 409);
      assert.ok(ok(await api('GET', `/api/dispensation/prescriptions/${rx.id}/labels`, undefined, S.admin)).labels[0].lots.some((l) => l.lotNumber === 'LB'));
      fail(await api('GET', '/api/dispensation/prescriptions', undefined, S.cashier), 403);
    });
    it('facturation d\'ordonnance : sans double sortie de stock, une seule fois, non remboursable ici', async () => {
      const pay = [{ method: 'tiers_payant', amount: 2000 }];
      const s = ok(await api('POST', '/api/ventes/sales', { prescriptionId: S.rx1, payments: pay }, S.cashier), 201);
      assert.deepEqual(await lotsOf(S.P1.id), { LA: 5, LB: 1 });
      fail(await api('POST', '/api/ventes/sales', { prescriptionId: S.rx1, payments: pay }, S.cashier), 409);
      fail(await api('POST', `/api/ventes/sales/${s.id}/refund`, { reason: 'test' }, S.admin), 409, 'PRESCRIPTION_SALE');
    });
  });

  describe('Base de référence, interactions, substitutions', () => {
    it('import JSON (lignes invalides rapportées) puis import CSV de plus de 100 Ko', async () => {
      const r = ok(await api('POST', '/api/integrations/import', { format: 'json', source: `TEST ${RUN}`,
        classes: [{ substance: 'ibuprofene', class: 'ains' }], rules: [{ termA: 'warfarine', termB: 'ains', severity: 'association_deconseillee', description: 'risque hémorragique (test)' }, { termA: 'a', termB: 'b', severity: 'x', description: '' }] }, S.admin));
      assert.equal(r.rules, 1); assert.equal(r.classes, 1); assert.equal(r.errors.length, 1);
      const lines = ['terme_a;terme_b;gravite;description']; for (let i = 0; i < 3000; i++) lines.push(`subst${i}a;subst${i}b;precaution;description de test numéro ${i}`);
      const csv = lines.join('\n'); assert.ok(csv.length > 100 * 1024);
      assert.equal(ok(await api('POST', '/api/integrations/import', { format: 'csv', kind: 'interactions', content: csv, source: `CSV ${RUN}` }, S.admin)).rules, 3000);
    });
    it('interaction détectée via la classe (warfarine + ibuprofène/AINS), niveau danger', async () => {
      const W = await newProduct('Coumadine', { dci: 'Warfarine', dosage: '5 mg', form: 'comprimé' });
      S.pat2 = ok(await api('POST', '/api/patients', { lastName: `Keita${RUN}`, firstName: 'Moussa' }, S.admin), 201).patient;
      const rx = ok(await api('POST', '/api/dispensation/prescriptions', { patientId: S.pat2.id, prescriberName: 'Dr Test', prescribedOn: day(0), items: [{ productId: W.id, quantity: 1 }, { productId: S.P1.id, quantity: 1 }] }, S.admin), 201);
      const it = rx.alerts.find((a) => a.type === 'interaction'); assert.ok(it, 'interaction attendue : ' + JSON.stringify(rx.alerts));
      assert.equal(it.level, 'danger'); S.rx2 = rx.id; S.W = W;
    });
    it('substitution : équivalent proposé, remplacement tracé, non-équivalent refusé', async () => {
      const P3 = await newProduct('Ibuprofène Gen 400', { dci: 'Ibuprofène', dosage: '400mg', form: 'Comprimé', isGeneric: true });
      const subs = ok(await api('GET', `/api/dispensation/substitutes?productId=${S.P1.id}`, undefined, S.admin)).substitutes;
      assert.ok(subs.some((s) => s.id === P3.id)); assert.ok(!subs.some((s) => s.id === S.W.id));
      const items = ok(await api('GET', `/api/dispensation/prescriptions/${S.rx2}`, undefined, S.admin)).items;
      const itP1 = items.find((i) => i.product_id === S.P1.id); const itW = items.find((i) => i.product_id === S.W.id);
      fail(await api('POST', `/api/dispensation/prescriptions/${S.rx2}/items/${itW.id}/substitute`, { productId: P3.id }, S.admin), 409);
      ok(await api('POST', `/api/dispensation/prescriptions/${S.rx2}/items/${itP1.id}/substitute`, { productId: P3.id }, S.admin));
      const after = ok(await api('GET', `/api/dispensation/prescriptions/${S.rx2}`, undefined, S.admin)).items.find((i) => i.product_id === P3.id);
      assert.equal(after.substituted_from_name, S.P1.name);
    });
  });

  describe('Achats, factures, rapports, conformité', () => {
    it('commande : envoi, réception partielle, sur-réception refusée, facture avec écart chiffré', async () => {
      const sup = ok(await api('POST', '/api/achats/suppliers', { name: `Laborex ${RUN}` }, S.admin), 201).supplier;
      const o = ok(await api('POST', '/api/achats/orders', { supplierId: sup.id, items: [{ productId: S.P1.id, quantity: 20, unitCost: 600 }] }, S.admin), 201);
      fail(await api('POST', `/api/achats/orders/${o.id}/receive`, { lines: [{ itemId: 'x', quantity: 1, lotNumber: 'Z', expiryDate: day(100) }] }, S.admin), 400);
      ok(await api('POST', `/api/achats/orders/${o.id}/send`, {}, S.admin));
      const item = ok(await api('GET', `/api/achats/orders/${o.id}`, undefined, S.admin)).items[0];
      const rec = ok(await api('POST', `/api/achats/orders/${o.id}/receive`, { lines: [{ itemId: item.id, quantity: 12, lotNumber: `PO-${RUN}`, expiryDate: day(200) }] }, S.admin));
      assert.deepEqual(rec, { status: 'partial', missing: 8 });
      fail(await api('POST', `/api/achats/orders/${o.id}/receive`, { lines: [{ itemId: item.id, quantity: 9, lotNumber: `PO2-${RUN}`, expiryDate: day(200) }] }, S.admin), 409);
      fail(await api('POST', `/api/achats/orders/${o.id}/cancel`, {}, S.admin), 409);
      const inv = ok(await api('POST', `/api/achats/orders/${o.id}/invoices`, { invoiceNumber: 'F-1', invoiceDate: day(0), lines: [{ itemId: item.id, quantity: 12, unitPrice: 650 }] }, S.admin), 201);
      assert.equal(inv.status, 'ecart'); assert.equal(inv.gapAmount, 600);
      assert.equal(ok(await api('GET', `/api/achats/orders/${o.id}/invoices`, undefined, S.admin)).invoices.length, 1);
    });
    it('rapports : chiffres cohérents, export CSV sans nom de patient', async () => {
      const r = ok(await api('GET', '/api/rapports/overview', undefined, S.admin));
      assert.ok(r.kpis.salesCount >= 3 && r.kpis.revenue >= 1800 + 2000 + 1000, JSON.stringify(r.kpis));
      assert.ok(r.byMethod.some((m) => m.method === 'tiers_payant'));
      const res = await fetch(`${base}/api/rapports/export/sales.csv`, { headers: { Authorization: `Bearer ${S.admin}` } });
      assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /attachment/);
      const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8');   // arrayBuffer : text() retirerait le BOM
      assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]); assert.ok(text.includes('VTE-') && !text.includes(S.patLast));
    });
    it('rappel de lot : patient à contacter retrouvé ; registre des produits contrôlés avec soldes', async () => {
      const t = ok(await api('GET', '/api/conformite/lot-trace?lotNumber=LB', undefined, S.admin)).lots.find((l) => l.product.id === S.P1.id);
      assert.ok(t.movements.some((m) => m.type === 'dispensation' && m.patient === `${S.patLast} Awa`));
      const C = await newProduct('Codéine contrôlée', { isControlled: true }); ok(await receive(C.id, 'CT', 10), 201);
      ok(await api('POST', '/api/ventes/sales', { items: [{ productId: C.id, quantity: 4 }], payments: [{ method: 'especes', amount: 4000 }] }, S.cashier), 201);
      const reg = ok(await api('GET', '/api/conformite/controlled-register', undefined, S.admin)).products.find((p) => p.productId === C.id);
      assert.deepEqual([reg.opening, reg.closing, reg.movements.map((m) => m.balance)], [0, 6, [10, 6]]);
    });
  });

  describe('CRM : fidélité, rappels, entretiens', () => {
    it('fidélité : gain sur le montant payé, utilisation plafonnée, remboursement symétrique, registre en ajout seul', async () => {
      ok(await api('PUT', '/api/crm/settings', { loyaltyEnabled: true, loyaltyEarnAmount: 1000, loyaltyPointValue: 10, reminderLeadDays: 3 }, S.admin));
      const P5 = await newProduct('Vitamine fidélité', { salePrice: 1000 }); S.P5 = P5; ok(await receive(P5.id, 'F1', 50), 201);
      const bal = async (id = S.pat.id) => ok(await api('GET', `/api/crm/loyalty/${id}`, undefined, S.admin)).balance;
      const sale = (body, token = S.cashier) => api('POST', '/api/ventes/sales', body, token);
      const base = await bal();
      const s1 = ok(await sale({ patientId: S.pat.id, items: [{ productId: P5.id, quantity: 5 }], payments: [{ method: 'especes', amount: 5000 }] }), 201);
      assert.equal(s1.earnedPoints, 5); assert.equal(await bal(), base + 5);
      const s2 = ok(await sale({ patientId: S.pat.id, items: [{ productId: P5.id, quantity: 2 }], redeemPoints: 3, payments: [{ method: 'especes', amount: 1970 }] }), 201);
      assert.equal(s2.total, 1970); assert.equal(s2.redeemedPoints, 3); assert.equal(s2.earnedPoints, 1); assert.equal(await bal(), base + 5 - 3 + 1);
      const d = ok(await api('GET', `/api/ventes/sales/${s2.id}`, undefined, S.admin)).sale; assert.equal(d.redeemedPoints, 3); assert.equal(d.redeemAmount, 30);
      fail(await sale({ patientId: S.pat.id, items: [{ productId: P5.id, quantity: 1 }], redeemPoints: 99999, payments: [{ method: 'especes', amount: 1 }] }), 409, 'POINTS_INSUFFICIENT');
      assert.equal((await sale({ items: [{ productId: P5.id, quantity: 1 }], redeemPoints: 1, payments: [{ method: 'especes', amount: 990 }] })).status, 400);   // pas de patient
      ok(await api('POST', `/api/ventes/sales/${s2.id}/refund`, { reason: 'retour' }, S.admin));
      assert.equal(await bal(), base + 5);                                                           // +3 restitués, −1 annulé
      assert.equal(ok(await api('POST', `/api/crm/loyalty/${S.pat.id}/adjust`, { points: -2, reason: 'correction de test' }, S.admin)).balance, base + 3);
      fail(await api('POST', `/api/crm/loyalty/${S.pat.id}/adjust`, { points: -100000, reason: 'trop' }, S.admin), 409);
      await assert.rejects(() => tx({ system: true }, (c) => c.query('DELETE FROM loyalty_ledger')), /ajout seul/);
    });
    it('CONCURRENCE : deux ventes utilisant les mêmes points → une seule réussit, solde jamais négatif', async () => {
      const p3 = ok(await api('POST', '/api/patients', { lastName: `Diallo${RUN}`, firstName: 'Fanta' }, S.admin), 201).patient;
      ok(await api('POST', `/api/crm/loyalty/${p3.id}/adjust`, { points: 5, reason: 'solde de départ' }, S.admin));
      const body = { patientId: p3.id, items: [{ productId: S.P5.id, quantity: 1 }], redeemPoints: 4, payments: [{ method: 'especes', amount: 960 }] };
      const res = await Promise.all([api('POST', '/api/ventes/sales', body, S.cashier), api('POST', '/api/ventes/sales', body, S.cashier)]);
      assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], res.map((r) => r.text.slice(0, 120)).join(' | '));
      assert.equal(ok(await api('GET', `/api/crm/loyalty/${p3.id}`, undefined, S.admin)).balance, 1);
    });
    it('rappels de renouvellement : génération idempotente, clôture automatique au retour du patient', async () => {
      const P6 = await newProduct('Amlodipine', { dci: 'Amlodipine', dosage: '5 mg', form: 'comprimé', renewalDays: 1 }); ok(await receive(P6.id, 'AM1', 20), 201);
      const dispenseOnce = async () => {
        const rx = ok(await api('POST', '/api/dispensation/prescriptions', { patientId: S.pat2.id, prescriberName: 'Dr Test', prescribedOn: day(0), items: [{ productId: P6.id, quantity: 1 }] }, S.admin), 201);
        ok(await api('POST', `/api/dispensation/prescriptions/${rx.id}/validate`, {}, S.admin)); ok(await api('POST', `/api/dispensation/prescriptions/${rx.id}/dispense`, {}, S.admin)); return rx.id;
      };
      const rx1 = await dispenseOnce();
      await tx({ system: true }, (c) => c.query(`UPDATE prescriptions SET dispensed_at = now() - interval '10 days' WHERE id = $1`, [rx1]));   // délivrée il y a 10 jours
      assert.equal(ok(await api('POST', '/api/crm/reminders/generate', {}, S.admin)).created, 1);
      const r = ok(await api('GET', '/api/crm/reminders', undefined, S.admin)).reminders.find((x) => x.patientName === `Keita${RUN} Moussa`);
      assert.ok(r && r.status === 'pending' && r.daysLate >= 8 && r.productName.includes('Amlodipine'), JSON.stringify(r));
      ok(await api('PATCH', `/api/crm/reminders/${r.id}`, { status: 'contacted', note: 'appelé' }, S.admin));
      assert.ok(ok(await api('GET', '/api/crm/reminders?status=contacted', undefined, S.admin)).reminders.some((x) => x.id === r.id && x.contactedAt));
      assert.equal(ok(await api('POST', '/api/crm/reminders/generate', {}, S.admin)).created, 0);                           // idempotent
      await dispenseOnce();                                                                                                    // le patient est revenu
      const g = ok(await api('POST', '/api/crm/reminders/generate', {}, S.admin)); assert.equal(g.closed, 1); assert.equal(g.created, 1);   // ancien rappel clos, nouveau cycle
      fail(await api('GET', '/api/crm/reminders', undefined, S.cashier), 403);
    });
    it('entretien pharmaceutique : contenu chiffré, absent des listes, consultation tracée, suivi à venir', async () => {
      const iv = ok(await api('POST', '/api/crm/interviews', { patientId: S.pat.id, kind: 'bilan_medication', interviewOn: day(0), summary: 'Patient confidentiel : observance partielle', actions: 'Piluler hebdomadaire', followUpOn: day(7) }, S.admin), 201);
      const raw = await tx({ system: true }, async (c) => (await c.query('SELECT summary_enc, actions_enc FROM pharma_interviews WHERE id = $1', [iv.id])).rows[0]);
      assert.ok(raw.summary_enc.startsWith('v1:') && !raw.summary_enc.includes('confidentiel') && raw.actions_enc.startsWith('v1:'));
      const list = ok(await api('GET', `/api/crm/interviews?patientId=${S.pat.id}`, undefined, S.admin)); assert.ok(list.interviews.length >= 1 && !JSON.stringify(list).includes('observance'));
      assert.ok(ok(await api('GET', `/api/crm/interviews/${iv.id}`, undefined, S.admin)).interview.summary.includes('observance partielle'));
      assert.ok(await tx({ system: true }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'interview.viewed' AND entity_id = $1`, [iv.id])).rows[0].n) >= 1);
      assert.ok(ok(await api('GET', '/api/crm/interviews?followUps=1', undefined, S.admin)).interviews.some((x) => x.id === iv.id));
      ok(await api('PATCH', `/api/crm/interviews/${iv.id}`, { followUpDone: true }, S.admin));
      assert.ok(!ok(await api('GET', '/api/crm/interviews?followUps=1', undefined, S.admin)).interviews.some((x) => x.id === iv.id));
      assert.equal((await api('POST', '/api/crm/interviews', { patientId: S.pat.id, kind: 'autre', interviewOn: day(3), summary: 'futur' }, S.admin)).status, 400);
      fail(await api('GET', '/api/crm/interviews', undefined, S.cashier), 403);
    });
  });

  describe('RH : planning, absences, pointage', () => {
    it('planning : chevauchement (garde de nuit incluse) refusé, bout à bout autorisé, absence bloquante', async () => {
      const staff = ok(await api('GET', '/api/rh/staff', undefined, S.admin)).staff; S.cashierId = staff.find((u) => u.name === 'Caissier').id;
      const sh = (date, start, end, kind) => api('POST', '/api/rh/shifts', { userId: S.cashierId, date, start, end, kind }, S.admin);
      const a = ok(await sh(day(1), '08:00', '16:00'), 201);
      fail(await sh(day(1), '15:00', '18:00'), 409, 'SHIFT_OVERLAP');
      ok(await sh(day(1), '16:00', '20:00'), 201);
      ok(await sh(day(1), '20:00', '08:00', 'garde'), 201);                                   // garde de nuit : finit le lendemain à 08:00
      fail(await sh(day(2), '06:00', '09:00'), 409, 'SHIFT_OVERLAP');                         // chevauche la fin de la garde
      assert.equal(ok(await api('POST', '/api/rh/absences', { userId: S.cashierId, startDate: day(5), endDate: day(6), kind: 'conge' }, S.admin), 201).conflictingShifts.length, 0);
      fail(await sh(day(5), '08:00', '12:00'), 409, 'ABSENCE_CONFLICT');
      assert.equal(ok(await api('POST', '/api/rh/absences', { userId: S.cashierId, startDate: day(1), endDate: day(1), kind: 'maladie' }, S.admin), 201).conflictingShifts.length, 3);   // avertissement, pas un blocage
      const list = ok(await api('GET', `/api/rh/shifts?from=${day(0)}&to=${day(7)}`, undefined, S.admin));
      assert.equal(list.shifts.length, 3); assert.ok(list.shifts.some((x) => x.start === '20:00' && x.end === '08:00' && x.kind === 'garde')); assert.ok(list.absences.length >= 2);
      ok(await api('DELETE', `/api/rh/shifts/${a.id}`, undefined, S.admin)); fail(await api('DELETE', `/api/rh/shifts/${a.id}`, undefined, S.admin), 404);
      fail(await api('GET', '/api/rh/shifts', undefined, S.cashier), 403);
    });
    it('pointage : chacun pointe pour soi (sans droit RH), un seul pointage ouvert, correction motivée et tracée', async () => {
      ok(await api('POST', '/api/rh/clock', { action: 'in' }, S.cashier));
      fail(await api('POST', '/api/rh/clock', { action: 'in' }, S.cashier), 409, 'ALREADY_CLOCKED_IN');
      assert.ok(ok(await api('GET', '/api/rh/clock', undefined, S.cashier)).open);
      assert.ok(ok(await api('POST', '/api/rh/clock', { action: 'out' }, S.cashier)).clockOut);
      fail(await api('POST', '/api/rh/clock', { action: 'out' }, S.cashier), 409, 'NOT_CLOCKED_IN');
      const hrs = ok(await api('GET', '/api/rh/hours', undefined, S.admin)).hours.find((h) => h.userId === S.cashierId); assert.equal(hrs.openEntries, 0);
      const entry = ok(await api('GET', `/api/rh/time-entries?userId=${S.cashierId}`, undefined, S.admin)).entries[0];
      const now = Date.now();
      assert.equal((await api('PATCH', `/api/rh/time-entries/${entry.id}`, { clockIn: new Date(now - 3600000).toISOString(), clockOut: new Date(now + 7200000).toISOString(), reason: 'futur' }, S.admin)).status, 400);
      ok(await api('PATCH', `/api/rh/time-entries/${entry.id}`, { clockIn: new Date(now - 8 * 3600000).toISOString(), clockOut: new Date(now - 4 * 3600000).toISOString(), reason: 'oubli de pointage' }, S.admin));
      assert.ok(ok(await api('GET', '/api/rh/hours', undefined, S.admin)).hours.find((h) => h.userId === S.cashierId).workedHours >= 4);
      fail(await api('GET', '/api/rh/hours', undefined, S.cashier), 403);
    });
  });

  describe('Fuseau horaire par pharmacie', () => {
    it('refuse un fuseau invalide, normalise un nom valide, expose le fuseau dans /me, le modifie', async () => {
      fail(await api('POST', '/api/superadmin/tenants', { name: `TZ ${RUN} a`, timezone: 'Mars/Phobos' }, S.sa), 400);
      fail(await api('POST', '/api/superadmin/tenants', { name: `TZ ${RUN} b`, timezone: '+01:00' }, S.sa), 400);
      const t = ok(await api('POST', '/api/superadmin/tenants', { name: `TZ ${RUN} c`, timezone: 'africa/douala', modules: ['stocks'] }, S.sa), 201).tenant;
      assert.equal(t.timezone, 'Africa/Douala');
      const email = `admin-tz-${RUN}@test.ml`;
      ok(await api('POST', `/api/superadmin/tenants/${t.id}/admin`, { fullName: 'Admin TZ', email, password: PWD }, S.sa), 201);
      const tok = await activate(email);
      assert.equal(ok(await api('GET', '/api/auth/me', undefined, tok)).user.timezone, 'Africa/Douala');
      ok(await api('PATCH', `/api/superadmin/tenants/${t.id}`, { timezone: 'Africa/Bamako' }, S.sa));
      assert.equal(ok(await api('GET', '/api/auth/me', undefined, tok)).user.timezone, 'Africa/Bamako');   // effet immédiat, sans reconnexion
      fail(await api('PATCH', `/api/superadmin/tenants/${t.id}`, { timezone: 'Nope/Nope' }, S.sa), 400);
      assert.equal(ok(await api('GET', '/api/auth/me', undefined, tok)).user.timezone, 'Africa/Bamako');   // refus : valeur inchangée
    });
    it('app_date() et app_today() suivent le fuseau posé par tx() (et retombent sur UTC sans fuseau)', async () => {
      const at = (timezone) => tx({ system: true, timezone }, async (c) => (await c.query(`SELECT app_date($1::timestamptz)::text AS d`, ['2026-11-14T23:30:00Z'])).rows[0].d);
      assert.equal(await at('Africa/Douala'), '2026-11-15');
      assert.equal(await at('Africa/Bamako'), '2026-11-14');
      assert.equal(await at('America/Bogota'), '2026-11-14');
      assert.equal(await at(''), '2026-11-14');
      const dbToday = await tx({ system: true, timezone: 'Pacific/Kiritimati' }, async (c) => (await c.query('SELECT app_today()::text AS d')).rows[0].d);
      assert.equal(dbToday, new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date()));
    });
  });

  describe('Multi-sites : groupe, quota, gérant local, accès patients (v0.7.0)', () => {
    const G = {}; const SITE = (id) => ({ 'X-Pharmacy-Id': id });
    const newGroup = async (label, maxSubsites) => {
      const t = ok(await api('POST', '/api/superadmin/tenants', { name: `Groupe ${label} ${RUN}`, maxSubsites, modules: MODULES }, S.sa), 201).tenant;
      const email = `admin-groupe-${label}-${RUN}@test.ml`;
      ok(await api('POST', `/api/superadmin/tenants/${t.id}/admin`, { fullName: `Admin Groupe ${label}`, email, password: PWD }, S.sa), 201);
      return { id: t.id, email, token: await activate(email) };
    };

    it('quota : l\'Admin du groupe ouvre des sous-pharmacies dans la limite fixée, jamais au-delà (même en parallèle)', async () => {
      Object.assign(G, await newGroup('A', 2));
      const me = ok(await api('GET', '/api/auth/me', undefined, G.token)).user;
      assert.equal(me.isGroupAdmin, true); assert.equal(me.groupMaxSites, 2);
      G.a = ok(await api('POST', '/api/groupe/sites', { name: `Site A ${RUN}`, city: 'Bamako' }, G.token), 201).site.id;
      const b = ok(await api('POST', '/api/groupe/sites', { name: `Site B ${RUN}`, timezone: 'Africa/Douala' }, G.token), 201).site; G.b = b.id;
      assert.equal(b.timezone, 'Africa/Douala');
      fail(await api('POST', '/api/groupe/sites', { name: `Site C ${RUN}` }, G.token), 409, 'SITE_QUOTA');
      const list = ok(await api('GET', '/api/groupe/sites', undefined, G.token));
      assert.deepEqual(list.group, { maxSites: 2, used: 2, remaining: 0 }); assert.equal(list.sites.length, 3);
      assert.deepEqual(list.sites.find((s) => s.id === G.a).modules.sort(), [...MODULES].sort());           // modules repris de la principale
      // concurrence : quota 1, trois créations simultanées → exactement une réussit
      const solo = await newGroup('Course', 1);
      const res = await Promise.all([1, 2, 3].map((i) => api('POST', '/api/groupe/sites', { name: `Course ${i} ${RUN}` }, solo.token)));
      assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409]);
      G.solo = solo;
    });

    it('la base refuse seule ce que l\'application refuserait : quota, profondeur, quota inférieur au nombre de sous-pharmacies', async () => {
      await assert.rejects(tx({ system: true }, (c) => c.query(`INSERT INTO tenants (name, slug, parent_id) VALUES ('Hors quota', $1, $2)`, [`hors-quota-${RUN}`, G.id])), /Quota/);
      await assert.rejects(tx({ system: true }, (c) => c.query('UPDATE tenants SET parent_id = $1 WHERE id = $2', [G.a, G.b])), /sous-pharmacie/);       // pas de sous-sous-pharmacie
      await assert.rejects(tx({ system: true }, (c) => c.query('UPDATE tenants SET max_subsites = 3 WHERE id = $1', [G.a])));                                 // une sous-pharmacie n'a pas de quota
      await assert.rejects(tx({ system: true }, (c) => c.query('UPDATE tenants SET max_subsites = 1 WHERE id = $1', [G.id])), /quota/i);                       // 2 sous-pharmacies existent
      fail(await api('PATCH', `/api/superadmin/tenants/${G.id}`, { maxSubsites: 1 }, S.sa), 409);
      fail(await api('PATCH', `/api/superadmin/tenants/${G.id}`, { groupPatientAccess: true }, S.sa), 400);       // le Superadmin n'accorde jamais l'accès patients
      fail(await api('PATCH', `/api/superadmin/tenants/${G.a}`, { groupPatientAccess: true }, S.sa), 400);
      fail(await api('PATCH', `/api/superadmin/tenants/${G.a}`, { maxSubsites: 2 }, S.sa), 400);
      fail(await api('POST', `/api/superadmin/tenants/${G.a}/admin`, { fullName: 'X', email: `x-${RUN}@test.ml`, password: PWD }, S.sa), 409);   // sous-pharmacie : pas d'Admin propre
    });

    it('gérant local : ne voit que sa pharmacie ; crée des employés de rang inférieur seulement', async () => {
      const gEmail = `gerant-a-${RUN}@test.ml`;
      const created = ok(await api('POST', '/api/users', { fullName: 'Gérant A', email: gEmail, role: 'gerant', password: PWD }, G.token, SITE(G.a)), 201);
      assert.equal(created.user.role, 'gerant');
      G.gerant = await activate(gEmail);
      const me = ok(await api('GET', '/api/auth/me', undefined, G.gerant)).user;
      assert.equal(me.tenantId, G.a); assert.equal(me.isGroupAdmin, false); assert.equal(me.acting, false);
      assert.ok(me.permissions.includes('users:write')); assert.ok(!me.permissions.includes('audit:read'));
      // aucune autre pharmacie, aucune vue de groupe
      for (const other of [G.b, G.id, S.A.id]) fail(await api('GET', '/api/auth/me', undefined, G.gerant, SITE(other)), 403, 'SITE_FORBIDDEN');
      fail(await api('GET', '/api/groupe/sites', undefined, G.gerant), 403);
      fail(await api('GET', '/api/users/audit/logs', undefined, G.gerant), 403);
      // employés : rôles strictement inférieurs
      const cEmail = `caissier-a-${RUN}@test.ml`;
      const emp = ok(await api('POST', '/api/users', { fullName: 'Caissier A', email: cEmail, role: 'caissier', password: PWD }, G.gerant), 201).user;
      fail(await api('POST', '/api/users', { fullName: 'Autre gérant', email: `gerant-x-${RUN}@test.ml`, role: 'gerant', password: PWD }, G.gerant), 400);
      fail(await api('POST', '/api/users', { fullName: 'Faux admin', email: `admin-x-${RUN}@test.ml`, role: 'admin', password: PWD }, G.gerant), 400);
      fail(await api('POST', '/api/users', { fullName: 'Avec droits users', email: `u-${RUN}@test.ml`, role: 'personnalise', permissions: ['users:write'], password: PWD }, G.gerant), 403);
      fail(await api('PATCH', `/api/users/${emp.id}`, { role: 'gerant' }, G.gerant), 400);                         // pas de promotion à son propre rang
      ok(await api('PATCH', `/api/users/${emp.id}`, { role: 'pharmacien' }, G.gerant));
      const tokEmp = await activate(cEmail); fail(await api('GET', '/api/users', undefined, tokEmp), 403);          // un employé ne gère pas les comptes
      const gerantRow = ok(await api('GET', '/api/users', undefined, G.token, SITE(G.a))).users.find((u) => u.role === 'gerant');
      fail(await api('PATCH', `/api/users/${gerantRow.id}`, { isActive: false }, G.gerant), 400);                    // pas sur soi-même
      // la liste de la sous-pharmacie ne contient que ses comptes (pas l'Admin du groupe)
      const emails = ok(await api('GET', '/api/users', undefined, G.gerant)).users.map((u) => u.email).sort();
      assert.deepEqual(emails, [cEmail, gEmail].sort());
      // traçabilité : la création du gérant par l'Admin du groupe est marquée comme telle
      const logs = await tx({ tenantId: G.a }, async (c) => (await c.query(`SELECT meta FROM audit_logs WHERE action = 'user.created' ORDER BY id`)).rows);
      assert.equal(logs[0].meta.via_group_admin, true); assert.ok(!logs[logs.length - 1].meta.via_group_admin);
    });

    it('Admin du groupe : dossiers patients fermés par défaut, accès accordé par le gérant local de chaque sous-pharmacie', async () => {
      let me = ok(await api('GET', '/api/auth/me', undefined, G.token, SITE(G.a))).user;
      assert.equal(me.acting, true); assert.equal(me.tenantId, G.a); assert.equal(me.patientDataRestricted, true);
      assert.ok(!me.permissions.some((p) => /^(patients|dispensation|crm):/.test(p))); assert.ok(!me.permissions.includes('ventes:write'));
      fail(await api('GET', '/api/patients', undefined, G.token, SITE(G.a)), 403);
      fail(await api('GET', '/api/ventes/lookup/patients?q=a', undefined, G.token, SITE(G.a)), 403);
      ok(await api('GET', '/api/ventes/sales', undefined, G.token, SITE(G.a)));                                      // pilotage : lecture des ventes possible
      // seul le gérant local décide : ni l'Admin du groupe (même dans la sous-pharmacie), ni une autre pharmacie, ni un employé
      fail(await api('PUT', '/api/site/patient-access', { granted: true }, G.token, SITE(G.a)), 403);
      fail(await api('PUT', '/api/site/patient-access', { granted: true }, G.token), 403);
      fail(await api('GET', '/api/site/patient-access', undefined, S.admin), 403);
      fail(await api('PUT', '/api/site/patient-access', { granted: true }, await activate(`caissier-a-${RUN}@test.ml`)), 403);
      assert.equal(ok(await api('GET', '/api/site/patient-access', undefined, G.gerant)).granted, false);
      ok(await api('PUT', '/api/site/patient-access', { granted: true }, G.gerant));
      me = ok(await api('GET', '/api/auth/me', undefined, G.token, SITE(G.a))).user; assert.equal(me.patientDataRestricted, false);
      ok(await api('GET', '/api/patients', undefined, G.token, SITE(G.a)));                                          // accordé pour A…
      fail(await api('GET', '/api/patients', undefined, G.token, SITE(G.b)), 403);                                   // …mais pas pour B
      ok(await api('PUT', '/api/site/patient-access', { granted: false }, G.gerant));
      fail(await api('GET', '/api/patients', undefined, G.token, SITE(G.a)), 403);                                   // retrait immédiat par le gérant
      const trace = await tx({ tenantId: G.a }, async (c) => (await c.query(`SELECT action FROM audit_logs WHERE action LIKE 'site.patient_access_%' ORDER BY id`)).rows.map((r) => r.action));
      assert.deepEqual(trace, ['site.patient_access_granted', 'site.patient_access_revoked']);
      // sa propre pharmacie (principale) : accès normal, sans en-tête
      ok(await api('GET', '/api/patients', undefined, G.token));
    });

    it('pointage : l\'Admin du groupe pointe dans sa pharmacie, jamais dans une sous-pharmacie où il travaille', async () => {
      ok(await api('GET', '/api/rh/clock', undefined, G.token));
      fail(await api('GET', '/api/rh/clock', undefined, G.token, SITE(G.a)), 403, 'CLOCK_ACTING');
      fail(await api('POST', '/api/rh/clock', { action: 'in' }, G.token, SITE(G.a)), 403, 'CLOCK_ACTING');
    });

    it('isolation : personne d\'autre ne peut travailler dans vos sous-pharmacies ni les modifier', async () => {
      fail(await api('GET', '/api/auth/me', undefined, S.admin, SITE(G.a)), 403, 'SITE_FORBIDDEN');                  // Admin d'une pharmacie ordinaire
      fail(await api('GET', '/api/auth/me', undefined, G.solo.token, SITE(G.a)), 403, 'SITE_FORBIDDEN');             // Admin d'un AUTRE groupe
      fail(await api('GET', '/api/auth/me', undefined, G.token, SITE('00000000-0000-4000-8000-000000000000')), 403, 'SITE_FORBIDDEN');   // inexistante : même réponse
      fail(await api('GET', '/api/auth/me', undefined, G.token, SITE('pas-un-uuid')), 400);
      fail(await api('PATCH', `/api/groupe/sites/${G.solo.id}`, { name: 'Pirate' }, G.token), 404);                    // pharmacie d'un autre groupe
      fail(await api('GET', '/api/groupe/sites', undefined, S.admin), 403);
      ok(await api('PATCH', `/api/groupe/sites/${G.a}`, { phone: '+223 70 00 00 00', timezone: 'Africa/Bamako' }, G.token));
      fail(await api('PATCH', `/api/groupe/sites/${G.a}`, { timezone: 'Nope/Nope' }, G.token), 400);
    });

    it('vue consolidée : une ligne par pharmacie active avec le module Rapports ; les autres sont signalées', async () => {
      const o = ok(await api('GET', '/api/groupe/overview', undefined, G.token));
      assert.equal(o.sites.length, 3); assert.equal(o.skipped.length, 0); assert.equal(o.totals.revenue, 0); assert.equal(o.totals.salesCount, 0);
      ok(await api('PUT', `/api/superadmin/tenants/${G.b}/modules`, { modules: ['stocks'] }, S.sa));
      const o2 = ok(await api('GET', '/api/groupe/overview', undefined, G.token));
      assert.equal(o2.sites.length, 2); assert.equal(o2.skipped.length, 1); assert.match(o2.skipped[0].reason, /Rapports/);
      fail(await api('GET', '/api/groupe/overview?from=2026-02-01&to=2026-01-01', undefined, G.token), 400);
    });

    it('abonnement du groupe : suspendre la principale bloque aussi les sous-pharmacies ; l\'Admin est attribuable à une autre personne', async () => {
      ok(await api('PATCH', `/api/superadmin/tenants/${G.id}`, { status: 'suspended' }, S.sa));
      fail(await api('GET', '/api/auth/me', undefined, G.gerant), 403, 'SUBSCRIPTION_INACTIVE');
      fail(await api('GET', '/api/auth/me', undefined, G.token), 403, 'SUBSCRIPTION_INACTIVE');
      ok(await api('PATCH', `/api/superadmin/tenants/${G.id}`, { status: 'active' }, S.sa));
      ok(await api('GET', '/api/auth/me', undefined, G.gerant));
      // attribution : l'ancien Admin est désactivé, ses sessions tombent ; un seul Admin actif
      fail(await api('POST', `/api/superadmin/tenants/${G.id}/admin`, { fullName: 'Nouveau', email: `nouveau-${RUN}@test.ml`, password: PWD }, S.sa), 409);
      ok(await api('POST', `/api/superadmin/tenants/${G.id}/admin`, { fullName: 'Nouvel Admin', email: `nouveau-${RUN}@test.ml`, password: PWD, replace: true }, S.sa), 201);
      fail(await api('GET', '/api/auth/me', undefined, G.token), 401, 'TOKEN_INVALID');
      const nt = await activate(`nouveau-${RUN}@test.ml`);
      const me = ok(await api('GET', '/api/auth/me', undefined, nt)).user; assert.equal(me.isGroupAdmin, true);
      assert.equal(ok(await api('GET', `/api/superadmin/tenants/${G.id}/admin`, undefined, S.sa)).admin.email, `nouveau-${RUN}@test.ml`);
    });
  });

  describe('Transferts de stock entre pharmacies du groupe (v0.8.0)', () => {
    const T = {}; const SITE = (id) => ({ 'X-Pharmacy-Id': id });
    const lots = async (token, productId) => Object.fromEntries(ok(await api('GET', `/api/stocks/products/${productId}`, undefined, token)).lots.map((l) => [l.lot_number, l.quantity]));
    const mkTransfer = async (token, toTenantId, lines, expected = 201) => ok(await api('POST', '/api/transferts', { toTenantId, lines }, token), expected).transfer;
    const types = async (token, productId) => ok(await api('GET', `/api/stocks/products/${productId}`, undefined, token)).movements.map((m) => m.type);

    before(async () => {
      const t = ok(await api('POST', '/api/superadmin/tenants', { name: `Groupe Transferts ${RUN}`, maxSubsites: 2, modules: MODULES }, S.sa), 201).tenant;
      const aEmail = `admin-trf-${RUN}@test.ml`;
      ok(await api('POST', `/api/superadmin/tenants/${t.id}/admin`, { fullName: 'Admin Trf', email: aEmail, password: PWD }, S.sa), 201);
      T.main = t.id; T.admin = await activate(aEmail);
      T.a = ok(await api('POST', '/api/groupe/sites', { name: `Trf A ${RUN}` }, T.admin), 201).site.id;
      T.b = ok(await api('POST', '/api/groupe/sites', { name: `Trf B ${RUN}` }, T.admin), 201).site.id;
      for (const [k, site] of [['gA', T.a], ['gB', T.b]]) {
        const email = `gerant-${k}-${RUN}@test.ml`;
        ok(await api('POST', '/api/users', { fullName: `Gérant ${k}`, email, role: 'gerant', password: PWD }, T.admin, SITE(site)), 201);
        T[k] = await activate(email);
      }
      T.pA = ok(await api('POST', '/api/stocks/products', { name: `Paracétamol TRF ${RUN}`, barcode: `BC-TRF-${RUN}`, form: 'Comprimé', dosage: '500 mg', salePrice: 500, purchasePrice: 300 }, T.gA), 201).product;
      ok(await api('POST', '/api/stocks/receive', { productId: T.pA.id, lotNumber: 'L1', expiryDate: day(60), quantity: 10 }, T.gA));
      ok(await api('POST', '/api/stocks/receive', { productId: T.pA.id, lotNumber: 'L2', expiryDate: day(200), quantity: 20 }, T.gA));
    });

    it('brouillon → expédition (FEFO) → réception : mêmes lots chez le destinataire, produit créé, traçabilité', async () => {
      const sites = ok(await api('GET', '/api/transferts/sites', undefined, T.gA)).sites;
      assert.deepEqual(sites.map((s) => s.id).sort(), [T.main, T.b].sort());                                   // les autres pharmacies du groupe, pas la sienne
      const tr = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 15 }]);
      assert.match(tr.number, /^TRF-\d{6}$/);
      assert.deepEqual(await lots(T.gA, T.pA.id), { L1: 10, L2: 20 });                                          // brouillon : rien n'est déplacé
      fail(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gB), 404);                                // le brouillon est invisible du destinataire
      assert.deepEqual(ok(await api('GET', '/api/transferts', undefined, T.gB)).transfers, []);
      ok(await api('POST', `/api/transferts/${tr.id}/send`, {}, T.gA));
      assert.deepEqual(await lots(T.gA, T.pA.id), { L1: 0, L2: 15 });                                          // FEFO : L1 (péremption proche) d'abord
      const seen = ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gB));
      assert.equal(seen.transfer.status, 'in_transit'); assert.equal(seen.transfer.direction, 'in');
      assert.deepEqual(seen.lots.map((l) => [l.lotNumber, l.quantity]).sort(), [['L1', 10], ['L2', 5]]);
      const rec = ok(await api('POST', `/api/transferts/${tr.id}/receive`, {}, T.gB));
      assert.equal(rec.createdProducts, 1);
      const pB = ok(await api('GET', '/api/stocks/products', undefined, T.gB)).products.find((p) => p.barcode === `BC-TRF-${RUN}`);
      assert.ok(pB && pB.id !== T.pA.id && pB.name === T.pA.name && pB.salePrice === 500);                     // produit créé chez B, attributs repris
      assert.deepEqual(await lots(T.gB, pB.id), { L1: 10, L2: 5 });
      assert.deepEqual(await lots(T.gA, T.pA.id), { L1: 0, L2: 15 });                                          // l'expéditeur n'est pas modifié par la réception
      assert.equal(ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gA)).transfer.status, 'received');
      assert.ok((await types(T.gA, T.pA.id)).includes('transfer_out')); assert.ok((await types(T.gB, pB.id)).includes('transfer_in'));
      fail(await api('POST', `/api/transferts/${tr.id}/receive`, {}, T.gB), 409, 'TRANSFER_STATE');            // pas de double réception
      fail(await api('POST', `/api/transferts/${tr.id}/cancel`, {}, T.gA), 409, 'TRANSFER_STATE');             // un transfert reçu ne s'annule pas
      T.pB = pB;
      // 2e transfert : le produit est reconnu par son code-barres (aucune création) et les lots cumulent
      const tr2 = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 5 }]);
      ok(await api('POST', `/api/transferts/${tr2.id}/send`, {}, T.gA));
      assert.equal(ok(await api('POST', `/api/transferts/${tr2.id}/receive`, {}, T.gB)).createdProducts, 0);
      assert.deepEqual(await lots(T.gB, pB.id), { L1: 10, L2: 10 });
    });

    it('refus puis reprise ; annulation en transit : le stock revient sur les lots d\'origine', async () => {
      const before = await lots(T.gA, T.pA.id);
      const t1 = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 3 }]);
      ok(await api('POST', `/api/transferts/${t1.id}/send`, {}, T.gA));
      fail(await api('POST', `/api/transferts/${t1.id}/refuse`, {}, T.gB), 400);                               // motif obligatoire
      ok(await api('POST', `/api/transferts/${t1.id}/refuse`, { reason: 'Lot endommagé' }, T.gB));
      assert.notDeepEqual(await lots(T.gA, T.pA.id), before);                                                  // le stock reste « en transit » tant que l'expéditeur ne reprend pas
      fail(await api('POST', `/api/transferts/${t1.id}/cancel`, {}, T.gA), 409, 'TRANSFER_STATE');
      ok(await api('POST', `/api/transferts/${t1.id}/return`, {}, T.gA));
      assert.deepEqual(await lots(T.gA, T.pA.id), before);
      const d = ok(await api('GET', `/api/transferts/${t1.id}`, undefined, T.gA));
      assert.equal(d.transfer.status, 'returned'); assert.equal(d.transfer.refusalReason, 'Lot endommagé');
      const t2 = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 4 }]);
      ok(await api('POST', `/api/transferts/${t2.id}/send`, {}, T.gA));
      ok(await api('POST', `/api/transferts/${t2.id}/cancel`, {}, T.gA));
      assert.deepEqual(await lots(T.gA, T.pA.id), before);
      assert.ok((await types(T.gA, T.pA.id)).includes('transfer_return'));
      fail(await api('POST', `/api/transferts/${t2.id}/receive`, {}, T.gB), 409, 'TRANSFER_STATE');            // annulé : plus rien à recevoir
    });

    it('réception partielle : quantités par lot, écart « en transit » puis repris par l\'expéditeur', async () => {
      const a0 = await lots(T.gA, T.pA.id); const b0 = await lots(T.gB, T.pB.id);
      const tr = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 8 }]);
      ok(await api('POST', `/api/transferts/${tr.id}/send`, {}, T.gA));
      const lot = ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gB)).lots[0];
      assert.equal(lot.quantity, 8); assert.equal(lot.receivedQuantity, null);
      const rcv = (received, expected) => api('POST', `/api/transferts/${tr.id}/receive`, { received }, T.gB).then((r) => (expected ? fail(r, expected) : ok(r)));
      await rcv({ [lot.id]: 9 }, 400); await rcv({ [lot.id]: -1 }, 400); await rcv({ [lot.id]: 2.5 }, 400);
      await rcv({ '00000000-0000-4000-8000-000000000000': 1 }, 400);
      fail(await api('POST', `/api/transferts/${tr.id}/receive`, { received: { [lot.id]: 0 } }, T.gB), 400, 'NOTHING_RECEIVED');
      assert.deepEqual(await lots(T.gB, T.pB.id), b0);                                                          // les tentatives invalides n'ont rien déplacé
      assert.equal(ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gB)).transfer.status, 'in_transit');
      const r = await rcv({ [lot.id]: 5 });
      assert.equal(r.shortfall, 3); assert.equal(r.status, 'received_short');
      assert.equal((await lots(T.gB, T.pB.id)).L2, b0.L2 + 5);                                                  // seule la quantité reçue entre en stock
      assert.equal((await lots(T.gA, T.pA.id)).L2, a0.L2 - 8);                                                  // l'écart reste hors stock tant qu'il n'est pas repris
      const seen = ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gA));
      assert.equal(seen.transfer.status, 'received_short'); assert.equal(seen.transfer.shortfallUnits, 3); assert.equal(seen.lots[0].receivedQuantity, 5);
      fail(await api('POST', `/api/transferts/${tr.id}/cancel`, {}, T.gA), 409, 'TRANSFER_STATE');
      fail(await api('POST', `/api/transferts/${tr.id}/return`, {}, T.gB), 403);                                // seule l'expéditrice reprend
      fail(await api('POST', `/api/transferts/${tr.id}/receive`, {}, T.gB), 409, 'TRANSFER_STATE');
      ok(await api('POST', `/api/transferts/${tr.id}/return`, {}, T.gA));
      assert.equal((await lots(T.gA, T.pA.id)).L2, a0.L2 - 5);                                                  // l'écart (3) est revenu sur le lot d'origine
      const done = ok(await api('GET', `/api/transferts/${tr.id}`, undefined, T.gA)).transfer;
      assert.equal(done.status, 'received'); assert.ok(done.shortfallSettledAt);
      fail(await api('POST', `/api/transferts/${tr.id}/return`, {}, T.gA), 409, 'TRANSFER_STATE');              // un écart ne se reprend qu'une fois
      assert.ok((await types(T.gA, T.pA.id)).includes('transfer_return'));
      // un lot entièrement manquant : aucune création de produit pour une ligne sans rien reçu (le produit existe déjà ici : lots inchangés)
      const t2 = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 2 }]);
      ok(await api('POST', `/api/transferts/${t2.id}/send`, {}, T.gA));
      const l2 = ok(await api('GET', `/api/transferts/${t2.id}`, undefined, T.gB)).lots[0];
      const x = ok(await api('POST', `/api/transferts/${t2.id}/receive`, { received: { [l2.id]: 2 } }, T.gB));
      assert.equal(x.shortfall, 0); assert.equal(x.status, 'received');
    });

    it('stock insuffisant, produit à registre, destinataire hors groupe ou hors règles : refusés', async () => {
      const before = await lots(T.gA, T.pA.id);
      const big = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 9999 }]);
      fail(await api('POST', `/api/transferts/${big.id}/send`, {}, T.gA), 409, 'INSUFFICIENT_STOCK');
      assert.deepEqual(await lots(T.gA, T.pA.id), before);                                                      // tout ou rien
      assert.equal(ok(await api('GET', `/api/transferts/${big.id}`, undefined, T.gA)).transfer.status, 'draft');
      const ctrl = ok(await api('POST', '/api/stocks/products', { name: `Stupéfiant TRF ${RUN}`, isControlled: true, salePrice: 1, purchasePrice: 1 }, T.gA), 201).product;
      fail(await api('POST', '/api/transferts', { toTenantId: T.b, lines: [{ productId: ctrl.id, quantity: 1 }] }, T.gA), 409, 'CONTROLLED_PRODUCT');
      fail(await api('POST', '/api/transferts', { toTenantId: T.a, lines: [{ productId: T.pA.id, quantity: 1 }] }, T.gA), 400);                   // vers soi-même
      fail(await api('POST', '/api/transferts', { toTenantId: S.A.id, lines: [{ productId: T.pA.id, quantity: 1 }] }, T.gA), 404);                // hors groupe : comme si elle n'existait pas
      fail(await api('POST', '/api/transferts', { toTenantId: T.b, lines: [] }, T.gA), 400);
      fail(await api('POST', '/api/transferts', { toTenantId: T.b, lines: [{ productId: T.pA.id, quantity: 0 }] }, T.gA), 400);
      fail(await api('POST', '/api/transferts', { toTenantId: T.a, lines: [{ productId: T.pA.id, quantity: 1 }] }, S.admin), 404);                // pharmacie ordinaire → sous-pharmacie du groupe
      // module Stocks désactivé chez le destinataire : refus
      ok(await api('PUT', `/api/superadmin/tenants/${T.b}/modules`, { modules: ['rapports'] }, S.sa));
      fail(await api('POST', '/api/transferts', { toTenantId: T.b, lines: [{ productId: T.pA.id, quantity: 1 }] }, T.gA), 409, 'PEER_NO_STOCKS');
      ok(await api('PUT', `/api/superadmin/tenants/${T.b}/modules`, { modules: MODULES }, S.sa));
    });

    it('droits : seul le bon côté agit ; employé sans droit refusé ; l\'Admin du groupe pilote ; le gérant ne voit pas le groupe', async () => {
      const t = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 1 }]);
      fail(await api('POST', `/api/transferts/${t.id}/send`, {}, T.gB), 404);                                    // B ne voit pas le brouillon de A
      ok(await api('POST', `/api/transferts/${t.id}/send`, {}, T.gA));
      fail(await api('POST', `/api/transferts/${t.id}/receive`, {}, T.gA), 403);                                // l'expéditeur ne réceptionne pas
      fail(await api('POST', `/api/transferts/${t.id}/cancel`, {}, T.gB), 403);                                 // le destinataire n'annule pas l'envoi
      fail(await api('POST', `/api/transferts/${t.id}/send`, {}, S.admin), 404);                                // une autre pharmacie ne voit rien
      fail(await api('GET', `/api/transferts/${t.id}`, undefined, S.admin), 404);
      const cEmail = `caissier-trf-${RUN}@test.ml`;
      ok(await api('POST', '/api/users', { fullName: 'Caissier Trf', email: cEmail, role: 'caissier', password: PWD }, T.gB), 201);
      const tokC = await activate(cEmail);
      fail(await api('POST', `/api/transferts/${t.id}/receive`, {}, tokC), 403);                                 // pas de droit stocks:transfer
      ok(await api('GET', '/api/transferts', undefined, tokC));                                                  // lecture : stocks:read suffit
      const g = ok(await api('GET', '/api/groupe/transfers', undefined, T.admin)).transfers;                     // l'Admin du groupe voit tout le groupe
      assert.ok(g.length >= 4 && g.every((x) => /^TRF-\d{6}$/.test(x.number)));
      fail(await api('GET', '/api/groupe/transfers', undefined, T.gA), 403);
      ok(await api('POST', `/api/transferts/${t.id}/receive`, {}, T.gB));
    });

    it('la base refuse ce que l\'application refuse : transfert hors groupe ; brouillon invisible du destinataire (RLS)', async () => {
      await assert.rejects(tx({ system: true }, (c) => c.query('INSERT INTO stock_transfers (from_tenant_id, to_tenant_id) VALUES ($1, $2)', [T.a, S.A.id])), /même groupe/);
      await assert.rejects(tx({ system: true }, (c) => c.query('INSERT INTO stock_transfers (from_tenant_id, to_tenant_id) VALUES ($1, $1)', [T.a])));
      const draft = await mkTransfer(T.gA, T.b, [{ productId: T.pA.id, quantity: 1 }]);
      const visibleToB = await tx({ tenantId: T.b }, async (c) => (await c.query('SELECT id FROM stock_transfers WHERE id = $1', [draft.id])).rowCount);
      assert.equal(visibleToB, 0);
      const linesVisibleToB = await tx({ tenantId: T.b }, async (c) => (await c.query('SELECT id FROM stock_transfer_lines WHERE transfer_id = $1', [draft.id])).rowCount);
      assert.equal(linesVisibleToB, 0);                                                                          // les lignes héritent de la visibilité du transfert
      const otherGroup = await tx({ tenantId: S.A.id }, async (c) => (await c.query('SELECT id FROM stock_transfers')).rowCount);
      assert.equal(otherGroup, 0);                                                                               // une autre pharmacie ne voit aucun transfert
      await assert.rejects(tx({ tenantId: T.b }, (c) => c.query(`INSERT INTO stock_transfers (from_tenant_id, to_tenant_id) VALUES ($1, $2)`, [T.a, T.b])));   // B ne peut pas créer un transfert « au nom » de A
    });
  });

  describe('Isolation multi-pharmacies (RLS) et intégrité', () => {
    it('la pharmacie B ne voit rien de A, par l\'API et par SQL direct', async () => {
      assert.equal(ok(await api('GET', '/api/patients', undefined, S.adminB)).patients.length, 0);
      fail(await api('GET', `/api/patients/${S.pat.id}`, undefined, S.adminB), 404);
      assert.ok(!ok(await api('GET', '/api/stocks/products', undefined, S.adminB)).products.some((p) => p.id === S.P1.id));
      assert.equal(ok(await api('GET', '/api/ventes/sales', undefined, S.adminB)).sales.length, 0);
      assert.equal(ok(await api('GET', '/api/integrations/interactions', undefined, S.adminB)).rules.length, 0);   // règles de A = propres à A
      assert.equal(ok(await api('GET', '/api/rh/shifts', undefined, S.adminB)).shifts.length, 0);
      assert.equal(ok(await api('GET', '/api/crm/reminders', undefined, S.adminB)).reminders.length, 0);
      fail(await api('GET', `/api/crm/loyalty/${S.pat.id}`, undefined, S.adminB), 404);
      fail(await api('POST', '/api/ventes/sales', { items: [{ productId: S.P1.id, quantity: 1 }], payments: [{ method: 'especes', amount: 1000 }] }, S.adminB), 404);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM patients')).rows[0].n, 0);                        // sans contexte : aucune ligne
      const count = (id) => tx({ tenantId: id }, async (c) => (await c.query('SELECT count(*)::int AS n FROM patients')).rows[0].n);
      assert.equal(await count(S.B.id), 0); assert.ok(await count(S.A.id) >= 2);
      await assert.rejects(() => tx({ tenantId: S.B.id }, (c) => c.query(`INSERT INTO patients (tenant_id, last_name, first_name) VALUES ($1,'x','y')`, [S.A.id])));   // écriture dans une autre pharmacie refusée
    });
    it('le journal d\'audit est en ajout seul (modification et suppression refusées)', async () => {
      await assert.rejects(() => tx({ system: true }, (c) => c.query('DELETE FROM audit_logs WHERE id = (SELECT min(id) FROM audit_logs)')), /ajout seul/);
      await assert.rejects(() => tx({ system: true }, (c) => c.query(`UPDATE audit_logs SET action = 'x' WHERE id = (SELECT min(id) FROM audit_logs)`)), /ajout seul/);
    });
  });

  describe('Sessions, verrouillage, 2FA', () => {
    it('refresh : cookie HttpOnly, rotation, et la réutilisation d\'un ancien jeton révoque toute la session', async () => {
      const cookieOf = (r) => { const sc = r.headers.get('set-cookie') || ''; const m = /pmp_rt=([^;]*)/.exec(sc); return { raw: sc, value: m ? m[1] : null }; };
      const withCookie = (value) => fetch(base + '/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `pmp_rt=${value}` }, body: '{}' }).then(async (res) => { const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ } return { status: res.status, body, text, headers: res.headers }; });
      const lr = await api('POST', '/api/auth/login', { email: S.A.email, password: PWD2 });
      const l = ok(lr); const c0 = cookieOf(lr);
      assert.ok(c0.value, 'cookie de refresh absent'); assert.match(c0.raw, /HttpOnly/); assert.match(c0.raw, /SameSite=Strict/); assert.match(c0.raw, /Path=\/api\/auth/);
      assert.equal(l.refreshToken, undefined, 'le refresh token ne doit pas figurer dans le corps de la réponse');
      const rr = await withCookie(c0.value); const r1 = ok(rr); const c1 = cookieOf(rr);
      assert.ok(r1.accessToken && c1.value && c1.value !== c0.value, 'rotation du cookie attendue'); assert.equal(r1.refreshToken, undefined);
      fail(await withCookie(c0.value), 401);                                   // ancien jeton rejoué
      fail(await withCookie(c1.value), 401);                                   // le nouveau est révoqué aussi
      fail(await api('POST', '/api/auth/refresh', { refreshToken: c1.value }), 401);   // le corps de requête n'est plus accepté
    });
    it('verrouillage après 5 échecs', async () => {
      const email = `lock-${RUN}@test.ml`; ok(await api('POST', '/api/users', { email, fullName: 'Verrou', role: 'caissier', password: PWD }, S.admin), 201);
      for (let i = 0; i < 5; i++) fail(await api('POST', '/api/auth/login', { email, password: 'FauxMotDePasse1' }), 401);
      fail(await api('POST', '/api/auth/login', { email, password: PWD }), 423, 'LOCKED');
    });
    it('2FA TOTP : activation puis connexion en deux étapes', async () => {
      const totp = require('../../src/lib/totp'); const email = `tfa-${RUN}@test.ml`;
      ok(await api('POST', '/api/users', { email, fullName: 'Deux FA', role: 'caissier', password: PWD }, S.admin), 201);
      const tok = await activate(email);
      const setup = ok(await api('POST', '/api/auth/2fa/setup', {}, tok));
      fail(await api('POST', '/api/auth/2fa/enable', { code: '000000' }, tok), 400);
      ok(await api('POST', '/api/auth/2fa/enable', { code: totp.totp(setup.secret) }, tok));
      const l = ok(await api('POST', '/api/auth/login', { email, password: PWD2 })); assert.equal(l.requires2fa, true); assert.ok(!l.accessToken);
      fail(await api('POST', '/api/auth/2fa/login', { tempToken: l.tempToken, code: '000000' }), 401);
      assert.ok(ok(await api('POST', '/api/auth/2fa/login', { tempToken: l.tempToken, code: totp.totp(setup.secret) })).accessToken);
    });
  });
});
