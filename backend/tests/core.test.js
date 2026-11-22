'use strict';
// Tests sans base de données : node --test backend/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/permissions');
const totp = require('../src/lib/totp');
const crypto = require('../src/lib/crypto');
const v = require('../src/lib/validate');

const KEY = 'a'.repeat(64);

test('admin obtient toutes les permissions des modules activés seulement', () => {
  const p = P.effectivePermissions({ role: 'admin', enabledModules: ['stocks'] });
  assert.ok(p.includes('users:write') && p.includes('stocks:adjust'));
  assert.ok(!p.some((x) => x.startsWith('ventes:')));
});

test('un rôle perd ses droits quand le module est désactivé', () => {
  assert.ok(P.effectivePermissions({ role: 'caissier', enabledModules: ['ventes'] }).includes('ventes:write'));
  assert.ok(!P.effectivePermissions({ role: 'caissier', enabledModules: [] }).includes('ventes:write'));
});

test('un employé ne peut jamais obtenir de permission core (users/audit)', () => {
  const p = P.effectivePermissions({ role: 'personnalise', permissions: ['users:write', 'stocks:read'], enabledModules: ['stocks'] });
  assert.deepEqual(p, ['stocks:read']);
});

test('invalidGrants : hors périmètre, inconnues et core sont refusées', () => {
  const admin = P.effectivePermissions({ role: 'admin', enabledModules: ['stocks'] });
  assert.deepEqual(P.invalidGrants(admin, ['stocks:read']), []);
  assert.deepEqual(P.invalidGrants(admin, ['ventes:read', 'users:write', 'foo:bar']).sort(), ['foo:bar', 'users:write', 'ventes:read']);
});

test('superadmin : aucun droit tenant', () => {
  assert.deepEqual(P.effectivePermissions({ role: 'superadmin', enabledModules: ['stocks'] }), []);
});

test('TOTP : vecteur RFC 6238 (SHA-1, secret ASCII 12345678901234567890)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.totp(secret, 59 * 1000), '287082');            // RFC 6238 : 94287082 → 6 derniers chiffres
  assert.equal(totp.totp(secret, 1111111109 * 1000), '081804');
  assert.ok(totp.verify(secret, '287082', 59 * 1000));
  assert.ok(!totp.verify(secret, '000000', 59 * 1000));
  assert.ok(totp.verify(secret, '287082', 59 * 1000 + 30000));     // tolérance ±1 pas
  assert.ok(!totp.verify(secret, '287082', 59 * 1000 + 120000));
});

test('AES-256-GCM : aller-retour, falsification détectée, clé invalide refusée', () => {
  const enc = crypto.encrypt('JBSWY3DPEHPK3PXP', KEY);
  assert.equal(crypto.decrypt(enc, KEY), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(enc, crypto.encrypt('JBSWY3DPEHPK3PXP', KEY)); // IV aléatoire
  const parts = enc.split(':'); parts[3] = Buffer.from('xxxxxxxxxxxxxxxx').toString('base64');
  assert.throws(() => crypto.decrypt(parts.join(':'), KEY));
  assert.throws(() => crypto.encrypt('x', 'court'));
});

test('mot de passe temporaire conforme à la politique', () => {
  for (let i = 0; i < 50; i++) assert.doesNotThrow(() => v.password(crypto.tempPassword()));
});

test('validation : email, mot de passe, slug, date', () => {
  assert.equal(v.email(' Aminata@Pharma.ML '), 'aminata@pharma.ml');
  assert.throws(() => v.email('pas-un-email'));
  assert.throws(() => v.password('court1'));
  assert.throws(() => v.password('uniquementdeslettres'));
  assert.equal(v.slugify('Pharmacie du Fleuve – Bamako'), 'pharmacie-du-fleuve-bamako');
  assert.throws(() => v.date('2026-13-45x'));
});

// ---------- Phase 2 ----------
const { allocateFEFO, stockStatus, expiryStatus } = require('../src/lib/stock');
const { checkAllergies } = require('../src/lib/clinical');

test('FEFO : consomme d\'abord le lot qui périme le plus tôt', () => {
  const lots = [
    { id: 'B', expiry_date: '2027-06-01', quantity: 10 },
    { id: 'A', expiry_date: '2027-01-15', quantity: 4 },
    { id: 'C', expiry_date: '2028-01-01', quantity: 50 },
  ];
  const r = allocateFEFO(lots, 7, '2026-11-05');
  assert.deepEqual(r.allocations, [{ lotId: 'A', quantity: 4 }, { lotId: 'B', quantity: 3 }]);
  assert.equal(r.shortfall, 0);
});

test('FEFO : ignore lots périmés et vides, signale le manque', () => {
  const lots = [
    { id: 'old', expiry_date: '2026-10-01', quantity: 100 },
    { id: 'zero', expiry_date: '2027-01-01', quantity: 0 },
    { id: 'ok', expiry_date: '2027-02-01', quantity: 5 },
  ];
  const r = allocateFEFO(lots, 8, '2026-11-05');
  assert.deepEqual(r.allocations, [{ lotId: 'ok', quantity: 5 }]);
  assert.equal(r.shortfall, 3);
  assert.equal(allocateFEFO(lots, 1, '2026-10-01').allocations[0].lotId, 'old'); // le jour même / avant péremption
});

test('statuts de stock et de péremption', () => {
  assert.equal(stockStatus(0, 5), 'rupture');
  assert.equal(stockStatus(5, 5), 'bas');
  assert.equal(stockStatus(6, 5), 'ok');
  assert.equal(stockStatus(3, 0), 'ok');
  assert.equal(expiryStatus('2026-11-04', '2026-11-05'), 'perime');
  assert.equal(expiryStatus('2026-11-05', '2026-11-05'), 'proche');
  assert.equal(expiryStatus('2027-02-03', '2026-11-05', 90), 'proche');
  assert.equal(expiryStatus('2027-02-04', '2026-11-05', 90), 'ok');
});

test('allergies : détection sur nom ou DCI, insensible aux accents/casse', () => {
  const prods = [{ id: '1', name: 'Clamoxyl 1 g', dci: 'Amoxicilline' }, { id: '2', name: 'Doliprane', dci: 'Paracétamol' }];
  assert.equal(checkAllergies(['amoxicilline'], prods).length, 1);
  assert.equal(checkAllergies(['PARACETAMOL'], prods)[0].productId, '2');
  assert.equal(checkAllergies(['pollen', 'ab'], prods).length, 0);
  assert.equal(checkAllergies([], prods).length, 0);
});

test('validation numérique', () => {
  assert.equal(v.int(5, { min: 1 }), 5);
  assert.throws(() => v.int(1.5)); assert.throws(() => v.int(0, { min: 1 }));
  assert.equal(v.money(12.345), 12.35); assert.throws(() => v.money(-1));
});

// ---------- Phase 3 ----------
const money = require('../src/lib/money');
const { suggestQuantity } = require('../src/lib/purchasing');

test('montants : centimes entiers, remise et total', () => {
  const t = money.computeTotals([{ unitPrice: 1500, quantity: 2 }, { unitPrice: 0.1, quantity: 3 }], 10);
  assert.equal(t.subtotalCents, 300030);          // 3000,30 — 0,1 × 3 sans erreur flottante
  assert.equal(t.discountCents, 30003);
  assert.equal(t.totalCents, 270027);
  assert.equal(money.computeTotals([{ unitPrice: 100, quantity: 1 }], 0).totalCents, 10000);
  assert.equal(money.computeTotals([{ unitPrice: 100, quantity: 1 }], 100).totalCents, 0);
});

test('paiements : somme exacte en centimes', () => {
  assert.equal(money.paymentsTotalCents([{ amount: 0.1 }, { amount: 0.2 }]), 30); // 0.1 + 0.2 ≠ 0.30000000000000004
  assert.equal(money.paymentsTotalCents([{ amount: 2700.27 }]), 270027);
});

test('suggestion de commande', () => {
  assert.equal(suggestQuantity({ available: 3, min: 10, max: 50 }), 47);
  assert.equal(suggestQuantity({ available: 3, onOrder: 5, min: 10, max: 50 }), 42);   // le déjà-commandé est déduit
  assert.equal(suggestQuantity({ available: 3, onOrder: 40, min: 10, max: 50 }), 0);   // assez de commandes en cours
  assert.equal(suggestQuantity({ available: 3, onOrder: 60, min: 10, max: 50 }), 0);
  assert.equal(suggestQuantity({ available: 11, min: 10, max: 50 }), 0);      // au-dessus du seuil
  assert.equal(suggestQuantity({ available: 4, min: 10 }), 16);               // sans max : 2 × min
  assert.equal(suggestQuantity({ available: 0, min: 0 }), 0);                 // pas de seuil
});

const { csvCell } = require('../src/lib/csv');
test('CSV : injection de formules neutralisée, échappement correct', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+33612345678'), "'+33612345678");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell(1500.5), '1500.5');
  assert.equal(csvCell(null), '');
});

// ---------- Phase 4 ----------
const { norm } = require('../src/lib/text');
const subst = require('../src/lib/substances');
const clin = require('../src/lib/clinical');
const { isEquivalent, equivalenceKey } = require('../src/lib/substitution');
const { compareInvoiceLine } = require('../src/lib/invoices');
const { parseCsv } = require('../src/lib/csvParse');
const backup = require('../src/lib/backup');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { Readable } = require('stream');

const CLASSES = [{ substance: 'ibuprofene', class: 'ains' }, { substance: 'diclofenac', class: 'ains' }, { substance: 'amoxicilline', class: 'penicillines' }];
const RULES = [
  { id: 'r1', term_a: 'ains', term_b: 'warfarine', severity: 'association_deconseillee', description: 'risque hémorragique', source: 'test' },
  { id: 'r2', term_a: 'ains', term_b: 'ains', severity: 'association_deconseillee', description: 'cumul d\'AINS', source: 'test' },
  { id: 'r3', term_a: 'paracetamol', term_b: 'warfarine', severity: 'a_prendre_en_compte', description: 'INR', source: 'test' },
];

test('substances : séparation des associations, normalisation, sels', () => {
  assert.deepEqual(subst.substancesOf('Amoxicilline + Acide clavulanique'), ['amoxicilline', 'acide clavulanique']);
  assert.deepEqual(subst.substancesOf('Paracétamol / Codéine'), ['paracetamol', 'codeine']);
  assert.deepEqual(subst.substancesOf(null), []);
  assert.ok(subst.matchesTerm('amoxicilline trihydratee', 'amoxicilline'));
  assert.ok(subst.matchesTerm('penicillines', 'penicilline'));            // pluriel
  assert.ok(!subst.matchesTerm('amoxicillinex', 'amoxicilline'));
});

test('interactions : warfarine + AINS détectée via la classe, niveau danger', () => {
  const items = [{ id: '1', name: 'Coumadine', dci: 'Warfarine' }, { id: '2', name: 'Advil', dci: 'Ibuprofène' }];
  const a = clin.findInteractions({ items, rules: RULES, classEntries: CLASSES });
  assert.equal(a.length, 1); assert.equal(a[0].level, 'danger'); assert.equal(a[0].severity, 'association_deconseillee'); assert.ok(a[0].message.includes('Coumadine'));
});

test('interactions : traitement récent pris en compte, deux récents entre eux ignorés', () => {
  const a = clin.findInteractions({ items: [{ id: '2', name: 'Advil', dci: 'Ibuprofène' }], recent: [{ id: '1', name: 'Coumadine', dci: 'Warfarine' }], rules: RULES, classEntries: CLASSES });
  assert.equal(a.length, 1); assert.equal(a[0].withRecent, true);
  const b = clin.findInteractions({ items: [{ id: '9', name: 'Autre', dci: 'Zinc' }], recent: [{ id: '1', name: 'Coumadine', dci: 'Warfarine' }, { id: '2', name: 'Advil', dci: 'Ibuprofène' }], rules: RULES, classEntries: CLASSES });
  assert.equal(b.length, 0);
});

test('interactions : même classe sur deux produits distincts seulement', () => {
  const two = clin.findInteractions({ items: [{ id: '1', name: 'Advil', dci: 'Ibuprofène' }, { id: '2', name: 'Voltarène', dci: 'Diclofénac' }], rules: RULES, classEntries: CLASSES });
  assert.equal(two.filter((x) => x.ruleId === 'r2').length, 1);
  assert.equal(clin.findInteractions({ items: [{ id: '1', name: 'Advil', dci: 'Ibuprofène' }], rules: RULES, classEntries: CLASSES }).length, 0);
});

test('interactions : tri par gravité et DCI manquante signalée', () => {
  const items = [{ id: '1', name: 'Coumadine', dci: 'Warfarine' }, { id: '2', name: 'Advil', dci: 'Ibuprofène' }, { id: '3', name: 'Doliprane', dci: 'Paracétamol' }];
  const a = clin.findInteractions({ items, rules: RULES, classEntries: CLASSES });
  assert.deepEqual(a.map((x) => x.severity), ['association_deconseillee', 'a_prendre_en_compte']);
  const m = clin.missingDciAlerts([{ id: '4', name: 'Tisane X', dci: '' }, { id: '1', name: 'Advil', dci: 'Ibuprofène' }]);
  assert.equal(m.length, 1); assert.equal(m[0].level, 'info');
});

test('allergies : classe thérapeutique (pénicillines → amoxicilline), sels et abscence de faux positifs', () => {
  const prods = [{ id: '1', name: 'Clamoxyl', dci: 'Amoxicilline trihydratée' }, { id: '2', name: 'Doliprane', dci: 'Paracétamol' }];
  const a = clin.checkAllergies(['Pénicillines'], prods, CLASSES);
  assert.equal(a.length, 1); assert.equal(a[0].productId, '1');
  assert.equal(clin.checkAllergies(['pénicillines'], prods, []).length, 0);   // sans base de classes : pas de détection (et c'est signalé côté interface)
  assert.equal(clin.checkAllergies(['latex'], prods, CLASSES).length, 0);
});

test('substitution : mêmes substances, dosage et forme', () => {
  const a = { id: '1', dci: 'Paracétamol', dosage: '500 mg', form: 'Comprimé' };
  assert.ok(isEquivalent(a, { id: '2', dci: 'paracetamol', dosage: '500mg', form: 'comprimé' }));
  assert.ok(!isEquivalent(a, { id: '3', dci: 'Paracétamol', dosage: '1 g', form: 'comprimé' }));
  assert.ok(!isEquivalent(a, { id: '4', dci: 'Paracétamol', dosage: '500 mg', form: 'sirop' }));
  assert.ok(!isEquivalent(a, { id: '1', dci: 'Paracétamol', dosage: '500 mg', form: 'Comprimé' }));   // pas lui-même
  assert.ok(!isEquivalent({ id: '5', dci: '', dosage: '1', form: 'x' }, { id: '6', dci: '', dosage: '1', form: 'x' }));   // DCI inconnue : jamais équivalent
  assert.equal(equivalenceKey({ dci: 'B + A', dosage: '5 mg', form: 'cp' }), equivalenceKey({ dci: 'a/b', dosage: '5mg', form: 'CP' }));
});

test('factures fournisseurs : écarts quantité/prix', () => {
  const ok = compareInvoiceLine({ receivedQty: 40, orderedPrice: 900, invoicedQty: 40, invoicedPrice: 900 });
  assert.equal(ok.hasGap, false); assert.equal(ok.impactCents, 0);
  const over = compareInvoiceLine({ receivedQty: 40, orderedPrice: 900, invoicedQty: 50, invoicedPrice: 950 });
  assert.equal(over.qtyGap, 10); assert.equal(over.priceGapCents, 5000); assert.equal(over.impactCents, 50 * 95000 - 40 * 90000);
  assert.equal(compareInvoiceLine({ receivedQty: 40, orderedPrice: 900, invoicedQty: 30, invoicedPrice: 900 }).qtyGap, -10);
});

test('CSV : séparateurs, guillemets, en-têtes normalisés, BOM', () => {
  const r = parseCsv('\uFEFFTerme A;Terme B;Gravité;Description\r\nwarfarine;ains;precaution;"risque; hémorragique"\r\n\r\nainsb;x;y;"a ""b"" c"');
  assert.equal(r.length, 2); assert.equal(r[0].terme_a, 'warfarine'); assert.equal(r[0].gravite, 'precaution'); assert.equal(r[0].description, 'risque; hémorragique'); assert.equal(r[1].description, 'a "b" c');
  assert.equal(parseCsv('a,b\n1,2')[0].b, '2');
  assert.deepEqual(parseCsv(''), []);
});

test('sauvegarde : chiffrement/déchiffrement, altération détectée, rotation, variables libpq', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')); const key = 'b'.repeat(64); const f = path.join(dir, backup.backupFileName(new Date('2026-11-06T10:00:00Z')));
  assert.equal(path.basename(f), 'pmp-20261106T100000Z.dump.enc');
  const payload = Buffer.concat([Buffer.from('PGDMP-fake-'), require('crypto').randomBytes(200000)]);
  await backup.encryptToFile(Readable.from([payload]), f, key);
  const raw = fs.readFileSync(f); assert.ok(!raw.includes(Buffer.from('PGDMP-fake-')));            // rien en clair
  const v1 = await backup.verifyBackup(f, key); assert.equal(v1.bytes, payload.length); assert.equal(v1.sha256, require('crypto').createHash('sha256').update(payload).digest('hex'));
  await assert.rejects(() => backup.verifyBackup(f, 'c'.repeat(64)));                                // mauvaise clé
  raw[1000] ^= 0xff; fs.writeFileSync(f, raw); await assert.rejects(() => backup.verifyBackup(f, key)); // altération
  for (const d of ['20261101', '20261102', '20261103', '20261104']) fs.writeFileSync(path.join(dir, `pmp-${d}T000000Z.dump.enc`), 'x');
  fs.writeFileSync(path.join(dir, 'autre.txt'), 'x');
  assert.deepEqual(backup.pruneBackups(dir, 2), ['pmp-20261103T000000Z.dump.enc', 'pmp-20261102T000000Z.dump.enc', 'pmp-20261101T000000Z.dump.enc']);   // 5 fichiers, on garde les 2 plus récents
  assert.equal(fs.readdirSync(dir).filter((x) => backup.NAME_RE.test(x)).length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'autre.txt')));
  assert.deepEqual(backup.pgEnvFromUrl('postgresql://app:p%40ss@db.example:5433/pharma?sslmode=require'), { PGHOST: 'db.example', PGPORT: '5433', PGUSER: 'app', PGPASSWORD: 'p@ss', PGDATABASE: 'pharma', PGSSLMODE: 'require' });
  fs.rmSync(dir, { recursive: true });
});

test('permissions : module conformité, lecture accordée au pharmacien seulement', () => {
  assert.ok(P.effectivePermissions({ role: 'pharmacien', enabledModules: ['conformite'] }).includes('conformite:read'));
  assert.ok(!P.effectivePermissions({ role: 'caissier', enabledModules: ['conformite'] }).includes('conformite:read'));
  assert.ok(P.effectivePermissions({ role: 'admin', enabledModules: ['conformite'] }).includes('conformite:export'));
});

const ref = require('../src/lib/reference');
test('référence : normalisation des règles et classes, rejet des lignes invalides', () => {
  const r = ref.normalizeRule({ termA: 'Warfarine', termB: 'AINS', severity: 'Association déconseillée', description: 'risque hémorragique' });
  assert.ok(r.ok); assert.equal(r.value.term_a, 'ains'); assert.equal(r.value.term_b, 'warfarine'); assert.equal(r.value.severity, 'association_deconseillee');   // ordonnés et normalisés
  assert.equal(ref.normalizeRule({ terme_a: 'a1', terme_b: 'b1', gravite: 'Précaution d\'emploi', description: 'xyz' }).value.severity, 'precaution');           // en-têtes CSV français
  assert.ok(!ref.normalizeRule({ termA: 'x', termB: 'y', severity: 'precaution', description: 'abc' }).ok);                                                        // termes trop courts
  assert.ok(!ref.normalizeRule({ termA: 'aaa', termB: 'bbb', severity: 'grave', description: 'abc' }).ok);                                                         // gravité inconnue
  assert.ok(!ref.normalizeRule({ termA: 'aaa', termB: 'bbb', severity: 'precaution', description: '' }).ok);
  assert.equal(ref.normalizeClass({ substance: 'Ibuprofène', class: 'AINS' }).value.substance, 'ibuprofene');
  assert.ok(!ref.normalizeClass({ substance: 'ab', class: 'x' }).ok);
  const p = ref.parseImportBody({ format: 'csv', kind: 'classes', content: 'substance;classe\nibuprofene;ains' });
  assert.equal(p.classes[0].classe, 'ains');
});

test('jeu d\'exemple : fichier valide, chaque règle/classe passe la normalisation', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reference.sample.json'), 'utf8'));
  assert.ok(/NON VALIDÉ/.test(d.source));
  assert.ok(d.rules.every((r) => ref.normalizeRule(r).ok) && d.classes.every((c) => ref.normalizeClass(c).ok));
  const classes = d.classes.map((c) => ref.normalizeClass(c).value); const rules = d.rules.map((r) => ({ id: r.termA + r.termB, ...ref.normalizeRule(r).value }));
  const a = clin.findInteractions({ items: [{ id: '1', name: 'Coumadine', dci: 'Warfarine' }, { id: '2', name: 'Nurofen', dci: 'Ibuprofène' }], rules, classEntries: classes });
  assert.equal(a.length, 1);
  assert.equal(clin.findInteractions({ items: [{ id: '1', name: 'Trinitrine', dci: 'Trinitrine' }, { id: '2', name: 'Viagra', dci: 'Sildénafil' }], rules, classEntries: classes })[0].severity, 'contre_indication');
});

// ---------- Phase 5 ----------
const loyalty = require('../src/lib/loyalty'); const reminders = require('../src/lib/reminders'); const shifts = require('../src/lib/shifts'); const hours = require('../src/lib/hours');

test('fidélité : points gagnés sur le montant payé, plafond d\'utilisation', () => {
  assert.equal(loyalty.earnedPoints(270000, 100000), 2);       // 2 700 FCFA payés, 1 point / 1 000 FCFA
  assert.equal(loyalty.earnedPoints(99999, 100000), 0);
  assert.equal(loyalty.earnedPoints(0, 100000), 0);
  assert.equal(loyalty.redeemValueCents(15, 1000), 15000);
  assert.equal(loyalty.maxRedeemablePoints(50, 100000, 1000), 50);     // solde suffisant et net couvre 50 × 10 FCFA
  assert.equal(loyalty.maxRedeemablePoints(500, 100000, 1000), 99);    // la vente reste payable : jamais 100 points = 100 %
  assert.equal(loyalty.maxRedeemablePoints(-3, 100000, 1000), 0);      // solde négatif (après remboursement) : rien d'utilisable
  assert.equal(loyalty.maxRedeemablePoints(10, 1, 1000), 0);
});

test('rappels : échéance = dernière délivrance + cycle, fenêtre d\'anticipation, tri', () => {
  const rows = [
    { patientId: 'b', productId: 'p1', lastOn: '2026-10-01', renewalDays: 30 },   // échéance 31/10 → en retard
    { patientId: 'a', productId: 'p2', lastOn: '2026-10-10', renewalDays: 30 },   // 09/11 → dans la fenêtre (aujourd'hui 07/11 + 3)
    { patientId: 'c', productId: 'p3', lastOn: '2026-10-20', renewalDays: 30 },   // 19/11 → trop tôt
    { patientId: 'd', productId: 'p4', lastOn: '2026-01-01', renewalDays: null }, // pas de cycle → jamais
  ];
  const due = reminders.computeDue(rows, '2026-11-07', 3);
  assert.deepEqual(due.map((d) => [d.patientId, d.dueOn, d.daysLate]), [['b', '2026-10-31', 7], ['a', '2026-11-09', -2]]);
  assert.equal(reminders.addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(reminders.computeDue(rows, '2026-11-07', 0).length, 1);
});

test('planning : chevauchements (garde de nuit incluse) et absences', () => {
  const ex = [{ shift_date: '2026-11-07', start_time: '08:00:00', end_time: '16:00:00' }, { shift_date: '2026-11-08', start_time: '20:00:00', end_time: '08:00:00' }];   // 2e = garde de nuit
  assert.ok(shifts.findOverlap({ date: '2026-11-07', start: '15:00', end: '18:00' }, ex));            // chevauche 8-16
  assert.ok(!shifts.findOverlap({ date: '2026-11-07', start: '16:00', end: '20:00' }, ex));            // bout à bout : autorisé
  assert.ok(shifts.findOverlap({ date: '2026-11-09', start: '06:00', end: '09:00' }, ex));             // la garde du 08 finit le 09 à 08:00
  assert.ok(!shifts.findOverlap({ date: '2026-11-09', start: '08:00', end: '12:00' }, ex));
  assert.equal(shifts.shiftMinutes('2026-11-08', '20:00', '08:00'), 720);
  assert.equal(shifts.absenceOn('2026-11-10', [{ start_date: '2026-11-09', end_date: '2026-11-12' }]).end_date, '2026-11-12');
  assert.equal(shifts.absenceOn('2026-11-13', [{ start_date: '2026-11-09', end_date: '2026-11-12' }]), undefined);
});

test('heures : somme des pointages fermés, pointage ouvert signalé', () => {
  const s = hours.summarize([
    { userId: 'u1', clockIn: '2026-11-07T08:00:00Z', clockOut: '2026-11-07T12:30:00Z' },
    { userId: 'u1', clockIn: '2026-11-07T14:00:00Z', clockOut: '2026-11-07T18:15:00Z' },
    { userId: 'u2', clockIn: '2026-11-07T08:00:00Z', clockOut: null },
  ]);
  assert.deepEqual(s.find((x) => x.userId === 'u1'), { userId: 'u1', minutes: 525, openEntries: 0, hours: 8.75 });
  assert.deepEqual(s.find((x) => x.userId === 'u2'), { userId: 'u2', minutes: 0, openEntries: 1, hours: 0 });
});

test('validation : heure HH:MM', () => {
  assert.equal(v.time('08:30'), '08:30'); assert.throws(() => v.time('24:00')); assert.throws(() => v.time('8:30')); assert.throws(() => v.time(830));
});

test('cookies : lecture, attributs de sécurité, effacement', () => {
  const ck = require('../src/lib/cookies');
  assert.equal(ck.readCookie('a=1; pmp_rt=abc%20def; b=2'), 'abc def');
  assert.equal(ck.readCookie('a=1; b=2'), null);
  assert.equal(ck.readCookie(undefined), null);
  assert.equal(ck.readCookie('pmp_rt=%E0%A4%A'), null);            // encodage invalide → ignoré, pas d'exception
  assert.equal(ck.readCookie('xpmp_rt=zzz'), null);                // pas de correspondance partielle
  const set = ck.serialize('tok', { secure: true });
  for (const a of ['pmp_rt=tok', 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', 'Secure']) assert.ok(set.includes(a), a);
  assert.ok(!/Max-Age/.test(set), 'cookie de session : pas de Max-Age');
  assert.ok(!/Secure/.test(ck.serialize('tok', { secure: false })));
  const sent = []; const res = { append: (h, v) => sent.push([h, v]) };
  ck.clearRefreshCookie(res, { secure: false });
  assert.match(sent[0][1], /Max-Age=0/);
});

test('xlsx : archive valide (signatures, CRC, contenu, noms d\'onglet, texte non interprété)', () => {
  const { buildXlsx, crc32, colName, sheetNames } = require('../src/lib/xlsx');
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);                       // vecteur de test standard
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  assert.deepEqual(sheetNames([{ name: 'a/b:c' }, { name: 'A B C' }, { name: 'x'.repeat(40) }]), ['a b c', 'A B C 2', 'x'.repeat(31)]);
  const buf = buildXlsx([{ name: 'Ventes', rows: [[{ v: 'Total', s: 'head' }], ['=1+1 & <b>'], [{ v: 12.5, s: 'money' }, { v: 3, s: 'int' }, null]] }, { name: 'Vide', rows: [] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const eocd = buf.length - 22; assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16); const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const crc = buf.readUInt32LE(off + 16); const size = buf.readUInt32LE(off + 20); const nl = buf.readUInt16LE(off + 28); const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nl); const data = buf.subarray(lho + 30 + buf.readUInt16LE(lho + 26), lho + 30 + buf.readUInt16LE(lho + 26) + size);
    assert.equal(crc32(data), crc, `CRC ${name}`); files[name] = data.toString('utf8'); off += 46 + nl;
  }
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(files[f], f);
  assert.match(files['xl/worksheets/sheet1.xml'], /t="inlineStr"><is><t xml:space="preserve">=1\+1 &amp; &lt;b&gt;<\/t>/);   // jamais une formule
  assert.ok(!/<f>/.test(files['xl/worksheets/sheet1.xml']));
  assert.match(files['xl/worksheets/sheet1.xml'], /<c r="A3" s="2"><v>12.5<\/v><\/c><c r="B3" s="3"><v>3<\/v><\/c>/);
  assert.throws(() => buildXlsx([]));
});

/* ---------------- 0.6.4 : fuseau horaire par pharmacie ---------------- */
const tzlib = require('../src/lib/tz');
const stockLib = require('../src/lib/stock');

test('fuseau : validation et normalisation des noms IANA', () => {
  assert.equal(tzlib.normalizeTimezone('Africa/Bamako'), 'Africa/Bamako');
  assert.equal(tzlib.normalizeTimezone('  africa/douala '), 'Africa/Douala');           // casse corrigée, espaces retirés
  assert.equal(tzlib.normalizeTimezone('UTC'), 'UTC');
  for (const bad of ['', '+01:00', 'GMT+1x', 'Mars/Phobos', 'Africa/', '../etc/passwd', 'A'.repeat(70), null, 42, undefined]) assert.equal(tzlib.normalizeTimezone(bad), null, String(bad));
  assert.equal(tzlib.isValidTimezone('Europe/Paris'), true); assert.equal(tzlib.isValidTimezone('Nope/Nope'), false);
});

test('fuseau : le jour local change selon la pharmacie (même instant)', () => {
  const t = new Date('2026-11-14T23:30:00Z');
  assert.equal(tzlib.localDate(t, 'UTC'), '2026-11-14');
  assert.equal(tzlib.localDate(t, 'Africa/Bamako'), '2026-11-14');        // UTC+0
  assert.equal(tzlib.localDate(t, 'Africa/Douala'), '2026-11-15');        // UTC+1
  assert.equal(tzlib.localDate(t, 'Pacific/Kiritimati'), '2026-11-15');   // UTC+14
  assert.equal(tzlib.localDate(new Date('2026-11-15T02:00:00Z'), 'America/Bogota'), '2026-11-14');   // UTC-5
  assert.equal(tzlib.localDateTime(t, 'Africa/Douala'), '2026-11-15 00:30:00');
  assert.equal(tzlib.localDateTime(new Date('2026-11-14T00:00:00Z'), 'UTC'), '2026-11-14 00:00:00');   // minuit : « 00 », jamais « 24 »
  assert.equal(tzlib.localDate(t, 'Nope/Nope'), '2026-11-14');            // fuseau inconnu → UTC, jamais d'exception
  assert.equal(stockLib.today('Africa/Douala', t), '2026-11-15'); assert.equal(stockLib.today(undefined, t), '2026-11-14');
});

test('fuseau : helpers de l\'interface (ui.js) — jour, saisie datetime-local, dates seules', () => {
  const vm = require('vm');
  const sandbox = { document: {}, navigator: {}, console, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'ui.js'), 'utf8')}\nthis.UI = UI;`, sandbox);
  const UI = sandbox.UI;
  UI.setTimezone('Africa/Douala');
  assert.equal(UI.getTimezone(), 'Africa/Douala');
  assert.equal(UI.today(new Date('2026-11-14T23:30:00Z')), '2026-11-15');
  assert.equal(UI.toInputValue('2026-11-14T23:30:00.000Z'), '2026-11-15T00:30');
  assert.equal(UI.fromInputValue('2026-11-15T00:30'), '2026-11-14T23:30:00.000Z');
  UI.setTimezone('Europe/Paris');                                          // heure d'été puis d'hiver
  assert.equal(UI.fromInputValue('2026-07-01T12:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(UI.fromInputValue('2026-12-01T12:00'), '2026-12-01T11:00:00.000Z');
  for (const iso of ['2026-07-01T10:00:00.000Z', '2026-12-01T11:00:00.000Z']) assert.equal(UI.fromInputValue(UI.toInputValue(iso)), iso);   // aller-retour
  UI.setTimezone('America/Bogota');                                        // fuseau négatif : une date seule ne glisse jamais
  assert.equal(UI.fmtDate('2026-12-31'), '31/12/2026'); assert.equal(UI.fmtDate('2027-01-01'), '01/01/2027');
  assert.match(UI.fmtDateTime('2026-11-15T02:00:00.000Z'), /14\/11\/2026.*21:00/);
  UI.setTimezone('Pas/UnFuseau'); assert.equal(UI.getTimezone(), 'UTC');   // nom invalide → UTC
  assert.equal(UI.fmtDate(null), '—');
  assert.throws(() => UI.fromInputValue(''), RangeError);                  // saisie vide : jamais d'instant inventé
});

/* ---------------- 0.7.0 : multi-sites, gérant local, hiérarchie des rôles ---------------- */
const Perm = require('../src/lib/permissions');
const Sites = require('../src/lib/sites');

test('rôles : hiérarchie stricte (on ne gère que les rangs inférieurs) et droits du gérant local', () => {
  assert.deepEqual(Perm.assignableRolesFor('admin'), ['gerant', 'pharmacien', 'preparateur', 'caissier', 'personnalise']);
  assert.deepEqual(Perm.assignableRolesFor('gerant'), ['pharmacien', 'preparateur', 'caissier', 'personnalise']);   // jamais un autre gérant ni un admin
  for (const r of ['pharmacien', 'preparateur', 'caissier', 'personnalise']) assert.deepEqual(Perm.assignableRolesFor(r), []);
  assert.equal(Perm.canManageRole('admin', 'gerant'), true); assert.equal(Perm.canManageRole('gerant', 'gerant'), false);
  assert.equal(Perm.canManageRole('gerant', 'admin'), false); assert.equal(Perm.canManageRole('caissier', 'caissier'), false);
  const mods = ['stocks', 'ventes', 'patients'];
  const g = Perm.effectivePermissions({ role: 'gerant', enabledModules: mods });
  assert.ok(g.includes('users:read') && g.includes('users:write') && g.includes('stocks:adjust') && g.includes('patients:write'));
  assert.ok(!g.includes('audit:read'));                                                        // le journal d'audit reste à l'Admin
  assert.ok(!g.includes('crm:read'));                                                          // module non activé
  assert.ok(Perm.effectivePermissions({ role: 'caissier', permissions: ['users:write'], enabledModules: mods }).every((p) => p !== 'users:write'));
  assert.deepEqual(Perm.invalidGrants(g, ['users:write']), ['users:write']);                   // un gérant ne délègue jamais la gestion des comptes
  assert.equal(Perm.ROLE_LABELS.gerant, 'Gérant local');
});

test('multi-sites : retrait des droits patients pour l\'Admin du groupe sans accès accordé', () => {
  const all = Perm.effectivePermissions({ role: 'admin', enabledModules: Perm.MODULE_KEYS });
  const r = Perm.withoutPatientAccess(all);
  for (const p of r) assert.ok(!/^(patients|dispensation|crm):/.test(p) && p !== 'ventes:write' && p !== 'ventes:refund', p);
  for (const keep of ['users:write', 'stocks:write', 'achats:approve', 'rapports:export', 'ventes:read', 'rh:write', 'conformite:read']) assert.ok(r.includes(keep), keep);
});

const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SITE = (o) => ({ status: 'active', subscription_end: null, timezone: 'UTC', parent_id: null, max_subsites: 0, group_patient_access: false, modules: [], ...o });
const MAIN = SITE({ id: U(1), name: 'Principale', max_subsites: 3, modules: ['stocks', 'rapports', 'patients', 'ventes', 'crm'] });
const CHILD = SITE({ id: U(2), name: 'Sous A', parent_id: U(1), modules: ['stocks', 'patients', 'ventes', 'achats'] });   // 'achats' n'existe pas dans la principale
const code = (c) => (e) => e.code === c;

test('multi-sites : pharmacie de travail — Admin du groupe, modules en intersection, droits patients', () => {
  const admin = { id: 'a', role: 'admin', permissions: [] };
  let w = Sites.resolveWorkSite({ u: admin, home: MAIN });
  assert.equal(w.acting, false); assert.equal(w.t.id, MAIN.id); assert.equal(w.isGroupAdmin, true); assert.ok(w.permissions.includes('patients:read') && w.permissions.includes('users:write'));
  w = Sites.resolveWorkSite({ u: admin, home: MAIN, site: CHILD, wanted: CHILD.id });
  assert.equal(w.acting, true); assert.equal(w.t.id, CHILD.id); assert.equal(w.restricted, true); assert.equal(w.isGroupAdmin, true);   // reste Admin de groupe
  assert.deepEqual(w.mods.sort(), ['patients', 'stocks', 'ventes']);                                     // ∩ principale : « achats » écarté
  assert.ok(!w.permissions.some((p) => /^(patients|crm|dispensation):/.test(p)) && !w.permissions.includes('ventes:write'));
  assert.ok(w.permissions.includes('ventes:read') && w.permissions.includes('stocks:write') && w.permissions.includes('users:write'));
  w = Sites.resolveWorkSite({ u: admin, home: MAIN, site: { ...CHILD, group_patient_access: true }, wanted: CHILD.id });    // accès accordé par le Superadmin
  assert.equal(w.restricted, false); assert.ok(w.permissions.includes('patients:read') && w.permissions.includes('ventes:write'));
  assert.equal(Sites.resolveWorkSite({ u: admin, home: MAIN, wanted: MAIN.id }).acting, false);          // sa propre pharmacie : pas de bascule
});

test('multi-sites : accès refusé hors groupe, aux non-Admin, aux gérants ; abonnement du groupe ; invalidité', () => {
  const admin = { id: 'a', role: 'admin', permissions: [] }; const gerant = { id: 'g', role: 'gerant', permissions: [] };
  const forbidden = (args) => assert.throws(() => Sites.resolveWorkSite(args), code('SITE_FORBIDDEN'));
  forbidden({ u: gerant, home: MAIN, site: CHILD, wanted: CHILD.id });                                   // gérant de la principale
  forbidden({ u: gerant, home: CHILD, parent: MAIN, site: MAIN, wanted: MAIN.id });                       // gérant d'une sous-pharmacie → la principale
  forbidden({ u: gerant, home: CHILD, parent: MAIN, site: SITE({ id: U(3), parent_id: U(1) }), wanted: U(3) });   // → une sœur
  forbidden({ u: admin, home: MAIN, site: SITE({ id: U(4), parent_id: U(9), modules: [] }), wanted: U(4) });      // pharmacie d'un AUTRE groupe
  forbidden({ u: admin, home: SITE({ id: U(5), modules: [] }), site: CHILD, wanted: CHILD.id });                  // Admin d'une pharmacie simple
  forbidden({ u: admin, home: MAIN, site: null, wanted: U(7) });                                                  // inexistante : même réponse
  assert.throws(() => Sites.resolveWorkSite({ u: admin, home: MAIN, wanted: 'pas-un-uuid' }), (e) => e.status === 400);
  // abonnement : le groupe expiré ou suspendu bloque aussi ses sous-pharmacies ; une sous-pharmacie suspendue est inaccessible
  const expired = { ...MAIN, subscription_end: '2020-01-01' };
  assert.throws(() => Sites.resolveWorkSite({ u: gerant, home: CHILD, parent: expired }), code('SUBSCRIPTION_INACTIVE'));
  assert.throws(() => Sites.resolveWorkSite({ u: admin, home: expired }), code('SUBSCRIPTION_INACTIVE'));
  assert.throws(() => Sites.resolveWorkSite({ u: admin, home: MAIN, site: { ...CHILD, status: 'suspended' }, wanted: CHILD.id }), code('SUBSCRIPTION_INACTIVE'));
  assert.equal(Sites.resolveWorkSite({ u: gerant, home: CHILD, parent: MAIN }).isGroupAdmin, false);
  const gw = Sites.resolveWorkSite({ u: gerant, home: CHILD, parent: MAIN });                              // gérant : sa pharmacie, modules ∩ principale
  assert.equal(gw.t.id, CHILD.id); assert.deepEqual(gw.mods.sort(), ['patients', 'stocks', 'ventes']); assert.ok(gw.permissions.includes('users:write'));
  assert.equal(Sites.resolveWorkSite({ u: { id: 's', role: 'superadmin', permissions: [] }, home: null, wanted: CHILD.id }).t, null);   // Superadmin : en-tête ignoré
  assert.equal(Sites.resolveWorkSite({ u: admin, home: SITE({ id: U(5) }) }).isGroupAdmin, false);        // quota 0 = pharmacie simple
});

/* ---------------- 0.7.1 : l'accès patients du groupe est décidé par le gérant local ---------------- */
test('multi-sites : seul le gérant local de la sous-pharmacie gère l\'accès patients du groupe', () => {
  const can = Sites.canManagePatientAccess;
  assert.equal(can({ role: 'gerant', acting: false, isSubsite: true }), true);
  assert.equal(can({ role: 'admin', acting: true, isSubsite: true }), false);          // l'Admin du groupe ne se l'accorde pas lui-même
  assert.equal(can({ role: 'admin', acting: false, isSubsite: false }), false);
  assert.equal(can({ role: 'gerant', acting: false, isSubsite: false }), false);       // gérant d'une pharmacie principale ou simple
  assert.equal(can({ role: 'gerant', acting: true, isSubsite: true }), false);
  assert.equal(can({ role: 'superadmin', acting: false, isSubsite: false }), false);   // ni le Superadmin
  assert.equal(can({ role: 'pharmacien', acting: false, isSubsite: true }), false);
  assert.equal(can(null), false);
  const gerant = { id: 'g', role: 'gerant', permissions: [] }; const admin = { id: 'a', role: 'admin', permissions: [] };
  assert.equal(Sites.resolveWorkSite({ u: gerant, home: CHILD, parent: MAIN }).isSubsite, true);
  assert.equal(Sites.resolveWorkSite({ u: admin, home: MAIN }).isSubsite, false);
  const w = Sites.resolveWorkSite({ u: admin, home: MAIN, site: CHILD, wanted: CHILD.id });
  assert.equal(w.isSubsite, true); assert.equal(can({ role: 'admin', acting: w.acting, isSubsite: w.isSubsite }), false);
});

/* ---------------- 0.8.0 : transferts de stock entre pharmacies du groupe ---------------- */
const Tr = require('../src/lib/transfers');

test('transferts : machine d\'états — qui peut faire quoi, depuis quel état', () => {
  assert.equal(Tr.nextStatus('draft', 'send', 'sender'), 'in_transit');
  assert.equal(Tr.nextStatus('draft', 'cancel', 'sender'), 'cancelled');
  assert.equal(Tr.nextStatus('in_transit', 'cancel', 'sender'), 'cancelled');
  assert.equal(Tr.nextStatus('in_transit', 'receive', 'receiver'), 'received');
  assert.equal(Tr.nextStatus('in_transit', 'refuse', 'receiver'), 'refused');
  assert.equal(Tr.nextStatus('refused', 'return', 'sender'), 'returned');
  const e = (st, a, side, status, c) => assert.throws(() => Tr.nextStatus(st, a, side), (x) => x.status === status && (!c || x.code === c), `${st}/${a}/${side}`);
  e('in_transit', 'receive', 'sender', 403); e('in_transit', 'send', 'receiver', 403); e('draft', 'refuse', 'sender', 403); e('refused', 'return', 'receiver', 403);   // mauvais côté
  e('draft', 'receive', 'receiver', 409, 'TRANSFER_STATE');                                  // rien à recevoir avant l'expédition
  for (const done of ['received', 'cancelled', 'returned']) for (const a of ['send', 'cancel', 'return']) e(done, a, 'sender', 409, 'TRANSFER_STATE');   // états finaux
  for (const done of ['received', 'cancelled', 'returned']) for (const a of ['receive', 'refuse']) e(done, a, 'receiver', 409, 'TRANSFER_STATE');
  e('received', 'cancel', 'sender', 409); e('refused', 'cancel', 'sender', 409); e('in_transit', 'return', 'sender', 409);   // un transfert reçu ne s'annule pas ; refusé : seule la reprise
  e('draft', 'inconnue', 'sender', 400);
  const t = { from_tenant_id: 'A', to_tenant_id: 'B' };
  assert.equal(Tr.sideOf(t, 'A'), 'sender'); assert.equal(Tr.sideOf(t, 'B'), 'receiver'); assert.equal(Tr.sideOf(t, 'C'), null);
  assert.equal(Tr.transferNumber(12), 'TRF-000012'); assert.equal(Tr.transferNumber('7'), 'TRF-000007');
});

test('transferts : appariement des produits du destinataire (code-barres, puis nom + forme + dosage)', () => {
  const cat = [
    { id: 1, name: 'Paracétamol', barcode: '3400111', form: 'Comprimé', dosage: '500 mg' },
    { id: 2, name: 'Amoxicilline', barcode: null, form: 'Gélule', dosage: '1 g' },
    { id: 3, name: 'Ibuprofène', barcode: '', form: 'Comprimé', dosage: '400 mg' },
    { id: 4, name: 'Ibuprofene', barcode: null, form: 'comprimé', dosage: '400 mg' },
  ];
  const m = Tr.matchProduct;
  assert.equal(m(cat, { product_name: 'Autre nom', barcode: '3400111', form: 'x', dosage: 'y' }).product.id, 1);       // le code-barres fait foi
  assert.equal(m(cat, { product_name: '  PARACETAMOL ', barcode: null, form: 'comprimé', dosage: '500  mg' }).product.id, 1);   // casse, accents, espaces
  assert.equal(m(cat, { product_name: 'Amoxicilline', barcode: '', form: 'Gélule', dosage: '1 g' }).product.id, 2);
  assert.deepEqual(m(cat, { product_name: 'Paracétamol', barcode: '9999', form: 'Comprimé', dosage: '500 mg' }), { product: cat[0] });   // code inconnu : retombe sur le nom
  assert.deepEqual(m(cat, { product_name: 'Paracétamol', barcode: null, form: 'Comprimé', dosage: '1000 mg' }), { product: null });     // autre dosage = autre produit → à créer
  assert.deepEqual(m(cat, { product_name: 'Ibuprofène', barcode: null, form: 'Comprimé', dosage: '400 mg' }), { ambiguous: true });     // deux candidats : jamais de choix silencieux
  assert.deepEqual(m([{ id: 5, name: 'A', barcode: 'X' }, { id: 6, name: 'B', barcode: 'x' }], { product_name: 'Z', barcode: 'X' }), { ambiguous: true });
  assert.deepEqual(m([], { product_name: 'Nouveau', barcode: null, form: null, dosage: null }), { product: null });
});

test('transferts : droit « stocks:transfer » (admin, gérant, pharmacien ; ni caissier ni préparateur)', () => {
  const mods = ['stocks'];
  assert.ok(Perm.effectivePermissions({ role: 'admin', enabledModules: mods }).includes('stocks:transfer'));
  assert.ok(Perm.effectivePermissions({ role: 'gerant', enabledModules: mods }).includes('stocks:transfer'));
  assert.ok(Perm.effectivePermissions({ role: 'pharmacien', enabledModules: mods }).includes('stocks:transfer'));
  assert.ok(!Perm.effectivePermissions({ role: 'caissier', enabledModules: mods }).includes('stocks:transfer'));
  assert.ok(!Perm.effectivePermissions({ role: 'preparateur', enabledModules: mods }).includes('stocks:transfer'));
  assert.ok(!Perm.effectivePermissions({ role: 'admin', enabledModules: [] }).includes('stocks:transfer'));        // module Stocks inactif
  assert.ok(Perm.effectivePermissions({ role: 'caissier', permissions: ['stocks:transfer'], enabledModules: mods }).includes('stocks:transfer'));   // délégable à la carte
  assert.ok(Perm.withoutPatientAccess(Perm.effectivePermissions({ role: 'admin', enabledModules: mods })).includes('stocks:transfer'));   // l'Admin du groupe garde le pilotage du stock
});

/* ---------------- 0.9.0 : réception partielle des transferts ---------------- */
test('transferts : réception partielle — plan lot par lot, écart, refus de l\'incohérent', () => {
  const lots = [{ id: 'a', quantity: 10 }, { id: 'b', quantity: 5 }];
  const full = Tr.planReceipt(lots, undefined);
  assert.equal(full.status, 'received'); assert.equal(full.shortfall, 0); assert.deepEqual(full.items.map((i) => i.received), [10, 5]);
  assert.equal(Tr.planReceipt(lots, null).status, 'received'); assert.equal(Tr.planReceipt(lots, {}).status, 'received');
  const part = Tr.planReceipt(lots, { a: 7 });                                          // lot non cité = reçu en entier
  assert.equal(part.status, 'received_short'); assert.equal(part.shortfall, 3); assert.deepEqual(part.items.map((i) => [i.received, i.short]), [[7, 3], [5, 0]]);
  assert.deepEqual(Tr.planReceipt(lots, { a: 0, b: 5 }).items.map((i) => i.received), [0, 5]);   // un lot entièrement manquant
  assert.equal(Tr.planReceipt(lots, { a: 0, b: 2 }).shortfall, 13);
  const bad = (rec, code) => assert.throws(() => Tr.planReceipt(lots, rec), (e) => e.status === 400 && (!code || e.code === code), JSON.stringify(rec));
  bad({ a: 11 }); bad({ a: -1 }); bad({ a: 2.5 }); bad({ a: '5' }); bad({ a: null }); bad({ zzz: 1 }); bad([1, 2]); bad('x');   // dépassement, négatif, décimal, texte, lot inconnu, forme invalide
  bad({ a: 0, b: 0 }, 'NOTHING_RECEIVED');                                              // rien reçu : il faut refuser
  assert.throws(() => Tr.planReceipt([], undefined), (e) => e.code === 'NOTHING_RECEIVED');
  assert.equal(Tr.planReceipt(lots, { a: 10, b: 5 }).status, 'received');                // tout explicitement reçu
  bad({ constructor: 1 }); bad(JSON.parse('{"__proto__": {"a": 1}}'));                  // clés piégées : traitées comme des lots inconnus, jamais comme des quantités
  // transitions liées
  assert.equal(Tr.nextStatus('received_short', 'return', 'sender'), 'received');         // l'écart repris solde le transfert
  assert.equal(Tr.nextStatus('refused', 'return', 'sender'), 'returned');
  for (const a of ['send', 'cancel']) assert.throws(() => Tr.nextStatus('received_short', a, 'sender'), (e) => e.status === 409);
  for (const a of ['receive', 'refuse']) assert.throws(() => Tr.nextStatus('received_short', a, 'receiver'), (e) => e.status === 409);
  assert.throws(() => Tr.nextStatus('received_short', 'return', 'receiver'), (e) => e.status === 403);   // seule l'expéditrice reprend
  assert.ok(Tr.STATUS_LABEL.received_short);
});
