/** Test de fumée de l'interface dans un vrai navigateur (Chromium via Playwright) contre un faux serveur d'API : npm run test:e2e
 *  Prérequis : npm i -D playwright && npx playwright install chromium (ou PLAYWRIGHT_PATH=/chemin/vers/playwright). */
const os = require('os'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
require('./server');
const SHOTS = process.env.E2E_SHOTS || os.tmpdir();
const BASE = 'http://localhost:8099';
const results = []; const errors = [];
const check = (name, ok, detail = '') => { results.push([ok, name, detail]); };
const A = '22222222-2222-4222-8222-222222222222';
async function open(browser, role) {
  await fetch(`${BASE}/__role/${role}`);
  const ctxt = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctxt.newPage(); CUR = page;
  page.on('pageerror', (e) => errors.push(`[${role}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) errors.push(`[${role}] console: ${m.text()}`); });   // les refus 4xx simulés sont attendus
  page.on('dialog', (d) => d.accept('Lot endommagé'));
  await page.addInitScript(() => sessionStorage.setItem('pmp_access', 'tok'));
  await page.goto(BASE + '/');
  return page;
}
const state = async () => (await fetch(`${BASE}/__state`)).json();
const has = async (page, text, t = 2500) => { try { await page.waitForSelector(`text=${text}`, { timeout: t }); return true; } catch { return false; } };
const nav = (page, label) => page.locator('nav button', { hasText: label });
const formErrors = async (page) => (await page.locator('.form-error').allTextContents()).filter(Boolean);
async function go(page, label, waitFor) { await nav(page, label).first().click(); const ok = await has(page, waitFor); check(`vue « ${label} » s'affiche (${waitFor})`, ok); const fe = await formErrors(page); check(`vue « ${label} » sans erreur affichée`, fe.length === 0, fe.join(' | ')); }

let CUR = null;
(async () => {
  const browser = await chromium.launch();
  try {
  /* ============ Admin du groupe ============ */
  let page = await open(browser, 'groupadmin');
  check('Admin du groupe : connecté (menu Mes pharmacies)', await has(page, 'Mes pharmacies'));
  const labels = await page.locator('nav button').allTextContents();
  for (const l of ['Mes pharmacies', 'Vue du groupe', 'Transferts de stock', 'Employés']) check(`menu contient « ${l} »`, labels.some((x) => x.includes(l)), labels.join(','));
  check('menu : pas de « Accès du groupe » (réservé au gérant)', !labels.some((x) => x.includes('Accès du groupe')));
  check('pointage : bouton visible dans sa propre pharmacie', (await page.locator('button', { hasText: 'Pointer l’arrivée' }).count()) === 1);
  check('sélecteur de pharmacie : 3 pharmacies', (await page.locator('select.site-switch option').count()) === 3);

  await go(page, 'Mes pharmacies', 'Sous-pharmacies ouvertes'); await page.screenshot({ path: SHOTS + '/s1_mes_pharmacies.png' });
  check('quota « 2 / 3 » affiché', await has(page, '2 / 3', 800));
  check('Sous B : « À désigner » (aucun gérant)', await has(page, 'À désigner', 800));
  check('boutons « Désigner le gérant » et « Autre gérant »', (await page.locator('button', { hasText: 'Désigner le gérant' }).count()) === 1 && (await page.locator('button', { hasText: 'Autre gérant' }).count()) === 1);
  check('sous-pharmacie A : accès patients « Fermés »', await has(page, 'Fermés', 800));
  await page.locator('button', { hasText: 'Nouvelle sous-pharmacie' }).click();
  check('dialogue « Nouvelle sous-pharmacie »', await has(page, 'Nom de la pharmacie'));
  await page.locator('form input[type=text]').first().fill('Sous C');
  await page.locator('form button[type=submit]').click(); await page.waitForTimeout(500);
  let st = await state(); check('création : POST /api/groupe/sites émis', st.calls.some((c) => c.startsWith('POST /api/groupe/sites')));
  await page.locator('button', { hasText: 'Désigner le gérant' }).click();
  check('dialogue « Gérant local — Sous B »', await has(page, 'Gérant local — Sous B'));
  await page.locator('form input[type=text]').first().fill('Ali Diallo'); await page.locator('form input[type=email]').first().fill('ali@test.ml');
  await page.locator('form button[type=submit]').click(); await page.waitForTimeout(500);
  st = await state(); check('gérant créé DANS la sous-pharmacie (POST /api/users avec en-tête de site B)', st.calls.some((c) => c.startsWith('POST /api/users') && c.includes('[site 33]')), st.calls.filter((c) => c.includes('users')).join(' ; '));
  await page.keyboard.press('Escape');

  await page.goto(BASE + '/'); await has(page, 'Mes pharmacies');
  await go(page, 'Vue du groupe', 'Chiffre d’affaires');
  check('vue du groupe : ligne « Total du groupe »', await has(page, 'Total du groupe', 800));
  check('vue du groupe : pharmacie non incluse signalée', await has(page, 'Non incluses', 800));
  check('vue du groupe : transferts récents du groupe', await has(page, 'Transferts de stock récents', 800));

  await go(page, 'Transferts de stock', 'TRF-000002');
  check('liste : 3 transferts', (await page.locator('text=/TRF-00000[234]/').count()) >= 3);
  await page.locator('button', { hasText: 'Nouveau transfert' }).click();
  await page.waitForSelector('form select', { timeout: 3000 }).catch(() => {}); check('dialogue « Nouveau transfert »', (await page.locator('form select').count()) > 0);
  const nopt = await page.locator('form select option').allTextContents(); check('destinataires proposés (2)', nopt.length === 2, JSON.stringify(nopt));
  await page.locator('form input[type=search]').fill('Para');
  check('recherche : produit disponible proposé', await has(page, 'Paracétamol 500 mg (30)'));
  check('recherche : produit à registre et produit en rupture absents', (await page.locator('text=Morphine').count()) === 0 && (await page.locator('text=Rupture X').count()) === 0);
  await page.locator('button', { hasText: 'Paracétamol 500 mg (30)' }).click();
  await page.locator('form input[type=number]').fill('12');
  await page.locator('form button[type=submit]').click();
  check('brouillon créé puis détail ouvert (bouton « Expédier »)', await has(page, 'Expédier'));
  st = await state(); const body = st.created[0] || {};
  check('POST /api/transferts : destinataire, ligne et quantité corrects', body.lines && body.lines.length === 1 && body.lines[0].productId === 'p1' && body.lines[0].quantity === 12 && !!body.toTenantId, JSON.stringify(body));
  check('détail du brouillon : bouton « Annuler le brouillon »', await has(page, 'Annuler le brouillon', 800));
  await page.locator('.modal button, [role=dialog] button', { hasText: 'Fermer' }).first().click().catch(() => page.keyboard.press('Escape'));

  await page.goto(BASE + '/'); await has(page, 'Transferts de stock'); await nav(page, 'Transferts de stock').click(); await has(page, 'TRF-000002');
  await page.locator('tr', { hasText: 'TRF-000002' }).locator('button', { hasText: 'Ouvrir' }).click();
  check('transfert reçu en transit : « Réceptionner » et « Refuser »', (await has(page, 'Réceptionner')) && (await has(page, 'Refuser', 800)));
  await page.screenshot({ path: SHOTS + '/s2_transfert_detail.png' });
  check('détail : lots expédiés listés (L1, L2, A9)', (await has(page, 'Lots expédiés', 800)) && (await page.locator('text=A9').count()) > 0);
  const recvInputs = page.locator('input[aria-label^="Quantité reçue du lot"]');
  check('réception : une saisie de quantité reçue par lot (3 lots, préremplies)', (await recvInputs.count()) === 3 && (await recvInputs.first().inputValue()) === '10');
  await recvInputs.first().fill('3'); await recvInputs.nth(2).fill('10');
  await page.locator('button', { hasText: 'Réceptionner' }).click(); await page.waitForTimeout(600);
  st = await state(); check('réception : POST /api/transferts/t2/receive émis', st.calls.includes('ACTION receive'));
  check('réception partielle : quantités par lot envoyées (k1 = 3, k2 = 5, k3 = 10)', st.received && st.received.received && st.received.received.k1 === 3 && st.received.received.k2 === 5 && st.received.received.k3 === 10, JSON.stringify(st.received));
  check('toast : écart signalé', await has(page, 'avec un écart de 7 unité(s)', 1500));
  check('toast : produit ajouté au catalogue', await has(page, 'ajouté(s) à votre catalogue', 1500));
  await has(page, 'TRF-000005'); await page.locator('tr', { hasText: 'TRF-000005' }).locator('button', { hasText: 'Ouvrir' }).click();
  check('réception partielle côté expéditeur : « Reprendre l’écart (7 unité(s)) » et écarts par lot', (await has(page, 'Reprendre l’écart (7 unité(s))')) && (await has(page, 'écart 7', 800)) && (await has(page, 'écart 8', 800)));
  await page.screenshot({ path: SHOTS + '/s5_ecart.png' });
  await page.locator('button', { hasText: 'Reprendre l’écart' }).click(); await page.waitForTimeout(500);
  st = await state(); check('reprise de l’écart : POST …/t5/return émis', st.calls.includes('ACTION return'));
  await has(page, 'TRF-000004'); await page.locator('tr', { hasText: 'TRF-000004' }).locator('button', { hasText: 'Ouvrir' }).click();
  check('transfert refusé : « Reprendre le stock » et motif visible', (await has(page, 'Reprendre le stock')) && (await has(page, 'Lot endommagé', 800)));
  await page.keyboard.press('Escape');

  await page.goto(BASE + '/'); await has(page, 'Mes pharmacies');
  await page.selectOption('select.site-switch', A); await page.waitForTimeout(700);
  st = await state(); check('bascule vers Sous A : requêtes avec l\'en-tête de site', st.calls.some((c) => c.startsWith('GET /api/auth/me') && c.includes('[site 22]')));
  check('Sous A : note « dossiers patients fermés »', await has(page, 'dossiers patients fermés', 1500)); await page.screenshot({ path: SHOTS + '/s3_sous_a.png' });
  check('Sous A : pas de bouton de pointage (le pointage est personnel)', (await page.locator('button', { hasText: 'Pointer l’arrivée' }).count()) === 0);
  const l2 = await page.locator('nav button').allTextContents();
  check('Sous A : modules patients/dispensation/CRM absents du menu', !l2.some((x) => /Patients|Dispensation|CRM/.test(x)), l2.join(','));
  check('Sous A : « Mes pharmacies » reste disponible à l\'Admin du groupe', l2.some((x) => x.includes('Mes pharmacies')));
  await page.close();

  /* ============ Gérant local ============ */
  page = await open(browser, 'gerant');
  check('gérant : connecté', await has(page, 'Accès du groupe'));
  const gl = await page.locator('nav button').allTextContents();
  check('gérant : pas de « Mes pharmacies » ni « Vue du groupe »', !gl.some((x) => /Mes pharmacies|Vue du groupe/.test(x)));
  check('gérant : pas de sélecteur de pharmacie', (await page.locator('select.site-switch').count()) === 0);
  check('gérant : « Transferts de stock » et « Employés » présents', gl.some((x) => x.includes('Transferts de stock')) && gl.some((x) => x.includes('Employés')));
  await go(page, 'Accès du groupe', 'Dossiers patients fermés à l’Admin du groupe'); await page.screenshot({ path: SHOTS + '/s4_acces_gerant.png' });
  await page.locator('button', { hasText: 'Accorder l’accès' }).click();
  check('accès accordé : état affiché', await has(page, 'Accès accordé à l’Admin du groupe'));
  st = await state(); check('PUT /api/site/patient-access { granted: true }', st.granted === true);
  await page.locator('button', { hasText: 'Retirer l’accès' }).click();
  check('accès retiré : état affiché', await has(page, 'Dossiers patients fermés à l’Admin du groupe'));
  st = await state(); check('retrait immédiat côté serveur', st.granted === false);
  await go(page, 'Employés', 'Fanta Sow');
  const modif = await page.locator('button', { hasText: 'Modifier' }).count();
  check('gérant : ne peut modifier que le caissier (rang inférieur) — 1 ligne éditable', modif === 1, `boutons Modifier : ${modif}`);
  await page.close();

  /* ============ Superadmin ============ */
  page = await open(browser, 'superadmin');
  check('superadmin : connecté', await has(page, 'Pharmacies'));
  await go(page, 'Pharmacies', 'Pharmacie Centrale');
  const rows = await page.locator('tbody tr').allTextContents();
  const idx = (t) => rows.findIndex((r) => r.includes(t));
  const kids2 = [idx('↳ Sous A'), idx('↳ Sous B')].sort(); check('sous-pharmacies regroupées sous leur principale', idx('Pharmacie Centrale') >= 0 && kids2[0] === idx('Pharmacie Centrale') + 1 && kids2[1] === idx('Pharmacie Centrale') + 2, rows.map((r) => r.slice(0, 20)).join(' | '));
  check('« groupe 2/3 » et « sous-pharmacie » affichés', (await has(page, 'groupe 2/3', 800)) && (await has(page, 'sous-pharmacie', 800)));
  const bodyTxt = () => page.locator('body').innerText();
  await page.locator('button', { hasText: 'Nouvelle pharmacie' }).first().click();
  check('création : champ « Sous-pharmacies autorisées »', await has(page, 'Sous-pharmacies autorisées'));
  await page.keyboard.press('Escape');
  await page.locator('tr', { hasText: 'Pharmacie Centrale' }).locator('button').first().click();
  check('gestion de la principale : quota + « Attribuer à une autre personne »', (await has(page, 'Sous-pharmacies autorisées')) && (await has(page, 'Attribuer à une autre personne')));
  check('gestion de la principale : pas de case « accès patients » (le Superadmin n\'y touche plus)', !(await bodyTxt()).includes('Autoriser l’Admin du groupe'));
  await page.keyboard.press('Escape');
  await page.locator('tr', { hasText: '↳ Sous A' }).locator('button').first().click();
  check('gestion d\'une sous-pharmacie : « administrée par l’Admin du groupe »', await has(page, 'administrée par l’Admin du groupe'));
  const t = await page.locator('form').first().innerText();
  check('sous-pharmacie : ni « Fin d’abonnement », ni quota, ni case accès patients (dans le dialogue)', !t.includes('Fin d’abonnement') && !t.includes('Sous-pharmacies autorisées') && !t.includes('Autoriser l’Admin du groupe'), t.slice(0, 200));
  await page.close();

  } catch (e) { check('HARNAIS interrompu', false, String(e.message).split('\n')[0]); try { await CUR.screenshot({ path: SHOTS + '/fail.png' }); console.log('texte page:', (await CUR.locator('body').innerText()).slice(0, 600)); } catch {} }
  await browser.close();
  const fails = results.filter((r) => !r[0]);
  for (const [ok, name, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && d ? `  → ${d}` : ''}`);
  console.log(`\n${results.length - fails.length}/${results.length} contrôles réussis ; erreurs JS/console : ${errors.length}`);
  [...new Set(errors)].forEach((e) => console.log('  ' + e));
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('ERREUR HARNAIS', e); process.exit(1); });
