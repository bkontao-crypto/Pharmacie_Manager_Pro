'use strict';
/**
 * Contrôles de COHÉRENCE statiques (sans base de données) :
 *  1) toute table/colonne citée dans le SQL du code existe dans les schémas ;
 *  2) tout appel d'API de l'interface correspond à une route réelle (méthode + chemin).
 * Ce n'est pas une exécution SQL : cela détecte les fautes de frappe et les oublis, pas les erreurs de logique.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/* ---------- schémas ---------- */
function loadSchema() {
  const tables = new Map();
  for (const f of fs.readdirSync(path.join(ROOT, 'backend/db')).filter((x) => /^schema.*\.sql$/.test(x)).sort()) {
    const sql = read(`backend/db/${f}`).replace(/--.*$/gm, '');
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      const cols = new Set();
      for (const line of m[2].split('\n')) { const c = line.match(/^\s{2}([a-z_]+)\s+[a-z]/); if (c && !['constraint', 'check', 'unique', 'primary', 'foreign'].includes(c[1])) cols.add(c[1]); }
      tables.set(m[1], cols);
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) tables.get(m[1]).add(m[2]);
  }
  return tables;
}

/* ---------- extraction des requêtes SQL (chaînes en MAJUSCULES : SELECT / INSERT INTO / UPDATE … SET / DELETE FROM) ---------- */
function sqlStrings() {
  const out = [];
  for (const f of walk('backend/src').concat(walk('backend/scripts')).filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    for (const m of src.matchAll(/`([^`]*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
      const s = (m[1] ?? m[2]);
      if (/\b(SELECT|INSERT INTO|DELETE FROM)\b/.test(s) || /\bUPDATE\s+\w+\s+(?:\w+\s+)?SET\b/.test(s)) out.push({ file: f, sql: s.replace(/\$\{[^}]*\}/g, '__X__') });
    }
  }
  return out;
}
const KEYWORDS = new Set(['where', 'on', 'left', 'right', 'inner', 'cross', 'join', 'group', 'order', 'limit', 'using', 'set', 'for', 'union', 'returning', 'and', 'or', 'as', 'values', 'select', 'offset', 'having']);

function checkSql(tables, { file, sql }) {
  const errors = []; const where = `${file}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}…`;
  const aliases = new Map(); // alias → Set(tables)
  const addAlias = (a, t) => { if (!aliases.has(a)) aliases.set(a, new Set()); aliases.get(a).add(t); };
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/g)) {
    const t = m[1]; if (t.includes('__X__') || /^[A-Z]/.test(t) && !tables.has(t)) continue;
    if (!tables.has(t)) { if (!['generate_series', 'unnest', 'lateral'].includes(t) && !/^(pg_|information_schema)/.test(t) && !/^\(/.test(t)) errors.push(`table inconnue « ${t} » — ${where}`); continue; }
    addAlias(t, t); if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) addAlias(m[2], t);
  }
  for (const m of sql.matchAll(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
    if (!tables.has(m[1])) { errors.push(`INSERT dans une table inconnue « ${m[1]} » — ${where}`); continue; }
    for (const c of m[2].split(',').map((x) => x.trim()).filter((x) => x && !x.includes('__X__'))) if (!tables.get(m[1]).has(c)) errors.push(`INSERT ${m[1]} : colonne inconnue « ${c} » — ${where}`);
  }
  for (const m of sql.matchAll(/\bUPDATE\s+(\w+)(?:\s+(\w+))?\s+SET\s+([\s\S]*?)(?:\sWHERE\b|\sRETURNING\b|$)/g)) {
    if (!tables.has(m[1])) { errors.push(`UPDATE d'une table inconnue « ${m[1]} » — ${where}`); continue; }
    addAlias(m[1], m[1]); if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) addAlias(m[2], m[1]);
    for (const a of m[3].matchAll(/(?:^|,\s*)(?:\w+\.)?([a-z_]+)\s*=(?!=)/g)) if (!a[1].includes('__X__') && !tables.get(m[1]).has(a[1])) errors.push(`UPDATE ${m[1]} : colonne inconnue « ${a[1]} » — ${where}`);
  }
  for (const m of sql.matchAll(/\bDELETE FROM\s+(\w+)/g)) if (!tables.has(m[1])) errors.push(`DELETE sur une table inconnue « ${m[1]} » — ${where}`); else addAlias(m[1], m[1]);
  // colonnes non qualifiées comparées à un paramètre (« WHERE colonne = $n ») : doivent exister dans l'une des tables de la requête
  const known = [...new Set([...aliases.values()].flatMap((ts) => [...ts]))];
  if (known.length) for (const m of sql.matchAll(/(?<![.\w$:'])([a-z_]+)\s*(?:=|<>|<=|>=|<|>)\s*\$\d/g)) {
    if (['interval', 'now', 'date'].includes(m[1])) continue;
    if (!known.some((t) => tables.get(t).has(m[1]))) errors.push(`colonne « ${m[1]} » absente de ${known.join('/')} — ${where}`);
  }
  for (const m of sql.matchAll(/\b([a-z][a-z_]*)\.([a-z_]+)\b/g)) {
    const ts = aliases.get(m[1]); if (!ts) continue;                       // alias défini ailleurs (requête composée) : non vérifiable ici
    if (![...ts].some((t) => tables.get(t).has(m[2]) || m[2] === 'id')) errors.push(`${m[1]}.${m[2]} : colonne absente de ${[...ts].join('/')} — ${where}`);
  }
  return errors;
}

test('SQL : toutes les tables et colonnes citées existent dans les schémas', () => {
  const tables = loadSchema(); assert.ok(tables.size >= 30, `schémas mal lus (${tables.size} tables)`);
  const qs = sqlStrings(); assert.ok(qs.length >= 150, `trop peu de requêtes détectées (${qs.length})`);
  const errors = [...new Set(qs.flatMap((q) => checkSql(tables, q)))];
  assert.deepEqual(errors, [], `\n${errors.join('\n')}`);
});

/* ---------- routes ↔ interface ---------- */
function backendRoutes() {
  const mounts = {}; for (const m of read('backend/src/app.js').matchAll(/app\.use\('([^']+)',\s*require\('\.\/routes\/(\w+)'\)/g)) mounts[m[2]] = m[1];
  const routes = [];
  for (const [name, prefix] of Object.entries(mounts)) {
    for (const m of read(`backend/src/routes/${name}.js`).matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)) {
      const full = (prefix + (m[2] === '/' ? '' : m[2])).replace(/\/$/, '');
      routes.push({ method: m[1].toUpperCase(), re: new RegExp(`^${full.replace(/:[A-Za-z]+/g, '[^/]+').replace(/\./g, '\\.')}$`), path: full });
    }
  }
  return routes;
}
function frontendCalls() {
  const calls = []; const M = { get: 'GET', post: 'POST', postPublic: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE', download: 'GET' };
  for (const f of walk('frontend/js').filter((x) => x.endsWith('.js'))) {
    for (const m of read(f).matchAll(/Api\.(get|post|postPublic|put|patch|del|download)\(\s*([`'])(\/api\/[\s\S]*?)\2/g)) {
      let p = m[3].split('?')[0].replace(/\$\{[^}]*\}/g, ':p'); if (p.length > 1) p = p.replace(/\/$/, '');
      calls.push({ method: M[m[1]], path: p, file: f });
    }
  }
  return calls;
}
test('interface : chaque appel d\'API correspond à une route existante', () => {
  const routes = backendRoutes(); const calls = frontendCalls();
  assert.ok(routes.length >= 100, `routes mal lues (${routes.length})`); assert.ok(calls.length >= 80, `appels mal lus (${calls.length})`);
  const missing = [...new Set(calls.filter((c) => !routes.some((r) => r.method === c.method && r.re.test(c.path.replace(/:p/g, 'x')))).map((c) => `${c.method} ${c.path} (${c.file})`))];
  assert.deepEqual(missing, [], `\nAppels sans route :\n${missing.join('\n')}`);
});

/* ---------- paramètres $n ↔ valeurs fournies ---------- */
/** Lit un gabarit `...` (avec ${…} imbriqués) à partir de l'indice du backtick ouvrant ; retourne { raw, end }. */
function readTemplate(src, i) {
  let j = i + 1; let raw = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { raw += src.slice(j, j + 2); j += 2; continue; }
    if (c === '`') return { raw, end: j + 1 };
    if (c === '$' && src[j + 1] === '{') { const e = skipExpr(src, j + 2); raw += src.slice(j, e); j = e; continue; }
    raw += c; j++;
  }
  throw new Error('gabarit non fermé');
}
/** Saute une expression ${ … } (accolades, chaînes, gabarits imbriqués) ; retourne l'indice après le « } » fermant. */
function skipExpr(src, i) {
  let depth = 1; let j = i;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '`') j = readTemplate(src, j).end;
    else if (c === "'" || c === '"') { j++; while (src[j] !== c) { if (src[j] === '\\') j++; j++; } j++; }
    else { if (c === '{') depth++; else if (c === '}') depth--; j++; }
  }
  return j;
}
/** Compte les éléments de premier niveau d'un tableau littéral commençant à src[i] === '[' ; null si un élément est un « ...spread ». */
function arrayLength(src, i) {
  let j = i + 1; let depth = 0; let n = 0; let started = false; let spread = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '`') { j = readTemplate(src, j).end; started = true; continue; }
    if (c === "'" || c === '"') { j++; while (src[j] !== c) { if (src[j] === '\\') j++; j++; } j++; started = true; continue; }
    if ('([{'.includes(c)) { depth++; started = true; j++; continue; }
    if (')}'.includes(c)) { depth--; j++; continue; }
    if (c === ']') { if (depth === 0) return spread ? null : (started ? n + 1 : 0); depth--; j++; continue; }
    if (c === ',' && depth === 0) { n++; started = false; j++; continue; }
    if (c === '.' && src.startsWith('...', j) && depth === 0 && !started) spread = true;
    if (!/\s/.test(c)) started = true;
    j++;
  }
  return null;
}
function paramChecks() {
  const problems = []; let checked = 0;
  for (const f of walk('backend/src').concat(walk('backend/scripts')).filter((x) => x.endsWith('.js'))) {
    const src = read(f); const consts = new Map();
    for (const m of src.matchAll(/^const (\w+) = (`)/gm)) { try { consts.set(m[1], readTemplate(src, m.index + m[0].length - 1).raw); } catch { /* ignoré */ } }
    const resolve = (raw, depth = 0) => raw.replace(/\$\{\s*(\w+)\s*\}/g, (x, name) => (consts.has(name) && depth < 4 ? resolve(consts.get(name), depth + 1) : '__X__')).replace(/\$\{[\s\S]*?\}/g, '__X__');
    for (const m of src.matchAll(/\.query\(\s*/g)) {
      let i = m.index + m[0].length; let sql; let end;
      if (src[i] === '`') { const t = readTemplate(src, i); sql = resolve(t.raw); end = t.end; }
      else if (src[i] === "'" || src[i] === '"') { const q = src[i]; let j = i + 1; let raw = ''; while (src[j] !== q) { if (src[j] === '\\') { raw += src[j + 1]; j += 2; continue; } raw += src[j]; j++; } sql = raw; end = j + 1; }
      else continue;                                                         // requête passée par une variable : non analysable
      i = end; while (/\s/.test(src[i])) i++;
      if (src[i] === '+') continue;                                          // concaténation : non analysable
      if (!/\b(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (/\$__X__|\$\$/.test(sql) || /\$\{/.test(sql)) continue;           // numérotation dynamique : non vérifiable
      const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])))].sort((a, b) => a - b);
      let count = 0;
      if (src[i] === ',') { i++; while (/\s/.test(src[i])) i++; if (src[i] !== '[') continue; const n = arrayLength(src, i); if (n === null) continue; count = n; }
      checked++;
      const max = used.length ? used[used.length - 1] : 0;
      if (max !== count) problems.push(`${f}:${line} — ${max} paramètre(s) dans le SQL, ${count} valeur(s) fournie(s) : ${sql.replace(/\s+/g, ' ').slice(0, 80)}…`);
      else if (used.length !== max) problems.push(`${f}:${line} — paramètres non contigus ($${used.join(', $')}) : ${sql.replace(/\s+/g, ' ').slice(0, 80)}…`);
    }
  }
  return { problems, checked };
}
test('SQL : le nombre de paramètres $n correspond aux valeurs fournies', () => {
  const { problems, checked } = paramChecks();
  assert.ok(checked >= 200, `trop peu de requêtes analysées (${checked})`);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

/* ---------- 0.6.4 : fuseau horaire par pharmacie ---------- */
test('fuseau : aucune notion de « jour » calculée en UTC dans les routes (hors tableau de bord Superadmin)', () => {
  const errors = [];
  for (const f of walk('backend/src/routes').filter((x) => x.endsWith('.js') && !x.endsWith('superadmin.js'))) {
    const src = read(f);
    if (/CURRENT_DATE/.test(src)) errors.push(`${f} : CURRENT_DATE → app_today()`);
    if (/\b[a-z]{1,2}\.(created_at|clock_in|dispensed_at)::date/.test(src)) errors.push(`${f} : colonne horodatée ::date → app_date(colonne)`);
    if (/\btoday\(\)/.test(src.replace(/app_today\(\)/g, ''))) errors.push(`${f} : today() sans fuseau → today(req.user.timezone)`);
    if (/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(src)) errors.push(`${f} : jour UTC → localDate(new Date(), req.user.timezone)`);
    const c = src.match(/const ctx = \(req\) => \(\{[^}]*\}\)/);
    if (c && !/timezone/.test(c[0])) errors.push(`${f} : ctx(req) doit transmettre req.user.timezone à tx()`);
    if (c && !/actingFrom/.test(c[0])) errors.push(`${f} : ctx(req) doit transmettre req.user.actingFrom (audit « via l'Admin du groupe »)`);
    if (/tx\(\{ tenantId: req\.user\.tenantId/.test(src)) errors.push(`${f} : tx({ tenantId… }) en ligne → tx(ctx(req), …)`);
  }
  assert.deepEqual(errors, []);
});

test('fuseau : l\'interface ne calcule aucun jour avec l\'heure UTC ou celle de l\'appareil', () => {
  const errors = [];
  for (const f of walk('frontend/js').filter((x) => x.endsWith('.js'))) {
    read(f).split('\n').forEach((line, i) => {
      if (/toISOString\(\)\.slice\(0, ?10\)/.test(line) && !/isoUTC =/.test(line)) errors.push(`${f}:${i + 1} jour UTC → UI.today()`);
      if ((/getTimezoneOffset|toLocale(Date|Time)String\(/.test(line) || /toLocaleString\([^)]*(dateStyle|timeStyle|hour:)/.test(line)) && !/timeZone/.test(line)) errors.push(`${f}:${i + 1} format local de l'appareil → UI.fmtDateTime / UI.fmtTime`);
    });
  }
  assert.deepEqual(errors, []);
});

test('migrations : tous les schémas du dossier db sont appliqués par migrate.js, dans l\'ordre', () => {
  const files = fs.readdirSync(path.join(ROOT, 'backend/db')).filter((x) => /^schema.*\.sql$/.test(x)).sort();
  const listed = [...read('backend/scripts/migrate.js').match(/const FILES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);   // sans require : 'pg' n'est pas installé pour les tests unitaires
  assert.deepEqual(listed, files);
  assert.match(read('backend/db/schema_phase6.sql'), /ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone/);
  assert.match(read('backend/db/schema_phase6.sql'), /FUNCTION app_today\(\)/);
});

/* ---------- 0.7.0 : multi-sites ---------- */
test('multi-sites : routes /groupe réservées à l\'Admin du groupe ; données patients masquées sans accès accordé', () => {
  assert.match(read('backend/src/routes/groupe.js'), /router\.use\(authenticate, blockIfMustChange, requireGroupAdmin\)/);
  assert.ok(!/tx\(\{ tenantId: req\.user\.tenantId/.test(read('backend/src/routes/groupe.js')), 'groupe.js doit utiliser homeTenantId / la pharmacie ciblée explicitement');
  assert.match(read('backend/src/routes/ventes.js'), /patientDataRestricted/);
  assert.match(read('backend/src/routes/conformite.js'), /patientDataRestricted/);
  assert.match(read('backend/src/app.js'), /\/api\/groupe/);
  const sql = read('backend/db/schema_phase7.sql');
  for (const needle of ["'gerant'", 'tenants_check_group', 'tenants_group_shape', 'max_subsites', 'group_patient_access']) assert.ok(sql.includes(needle), needle);
});

test('hiérarchie des rôles : users.js filtre les rôles selon l\'acteur et contrôle le rang de la cible', () => {
  const src = read('backend/src/routes/users.js');
  assert.ok(!/P\.ASSIGNABLE_ROLES/.test(src), 'valider les rôles avec P.assignableRolesFor(req.user.role), jamais la liste complète');
  assert.equal((src.match(/P\.canManageRole\(req\.user\.role, target\.role\)/g) || []).length, 2, 'modification ET réinitialisation de mot de passe contrôlent le rang');
});

test('accès patients du groupe : décidé par le gérant local seul (ni Superadmin, ni Admin du groupe)', () => {
  const sa = read('backend/src/routes/superadmin.js');
  assert.ok(!/add\('group_patient_access'/.test(sa) && !/SET group_patient_access/.test(sa), 'le Superadmin ne modifie pas group_patient_access');
  assert.ok(!/group_patient_access\s*=/.test(read('backend/src/routes/groupe.js')), 'l\'Admin du groupe ne se l\'accorde pas');
  const site = read('backend/src/routes/site.js');
  assert.match(site, /router\.use\([^)]*requireLocalManager\)/);
  assert.equal((site.match(/group_patient_access\s*=/g) || []).length, 1, 'une seule écriture, dans routes/site.js');
  assert.match(read('backend/src/app.js'), /\/api\/site/);
  assert.match(read('backend/src/lib/sites.js'), /canManagePatientAccess = \(user\) => [^\n]*!user\.acting/);
});

/* ---------- 0.8.0 : transferts de stock ---------- */
test('transferts : droits, contextes et garde-fous des routes', () => {
  const src = read('backend/src/routes/transferts.js');
  const mutating = [...src.matchAll(/router\.post\('([^']*)', ([^\n]*)/g)];
  assert.equal(mutating.length, 6, 'création, expédition, annulation, réception, refus, reprise');
  for (const [, route, rest] of mutating) assert.match(rest, /requirePermission\('stocks:transfer'\)/, `POST ${route}`);
  assert.ok(!/tx\(\{ system: true \}[^)]*\)[^;]*consumeFEFO|restock\(|receiveLot\(/.test(src.split('async function peerOf')[1].split('const LIST_SQL')[0]), 'le contrôle de groupe (contexte système) ne touche jamais au stock');
  for (const op of ['send', 'cancel', 'receive', 'refuse', 'return']) {
    const body = src.split(`router.post('/:id/${op}'`)[1].split('\nrouter.')[0].split('\n// POST')[0];
    assert.match(body, /tx\(ctx\(req\)/, `${op} : transaction dans le contexte RLS de la pharmacie qui agit`);
    assert.match(body, /lockTransfer\(c, id\)/, `${op} : verrou du transfert (pas de double action concurrente)`);
    assert.match(body, /nextStatus\(/, `${op} : machine d'états`);
  }
  assert.equal((src.match(/peerOf\(me\(req\)/g) || []).length, 2, 'groupe, abonnement et module vérifiés à la création ET à l\'expédition');
  assert.equal((src.match(/CONTROLLED_PRODUCT/g) || []).length, 2, 'produits à registre refusés à la création ET à l\'expédition');
  assert.match(src, /type: 'transfer_out'/); assert.match(src, /type: 'transfer_in'/); assert.match(src, /type: 'transfer_return'/);
  assert.match(read('backend/src/app.js'), /\/api\/transferts/);
  const sql = read('backend/db/schema_phase8.sql');
  for (const needle of ['stock_transfers_check_group', 'transfers_select', "status <> 'draft'", 'FORCE ROW LEVEL SECURITY', "'transfer_out','transfer_in','transfer_return'", 'child_select']) assert.ok(sql.includes(needle), needle);
});

test('transferts : tout type de mouvement du code est accepté par la base et libellé', () => {
  const sql = [...fs.readdirSync(path.join(ROOT, 'backend/db')).filter((f) => /^schema.*\.sql$/.test(f)).sort()].map((f) => read(`backend/db/${f}`)).join('\n');
  const checks = [...sql.matchAll(/stock_movements_type_check\s+CHECK \(type IN \(([^)]*)\)\)/g)];
  const allowed = [...checks[checks.length - 1][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);                 // dernière définition = celle en vigueur
  const used = new Set();
  for (const f of walk('backend/src').filter((x) => x.endsWith('.js'))) for (const m of read(f).matchAll(/type: '([a-z_]+)'|, '([a-z_]+)',\s*\$\d+/g)) used.add(m[1] || m[2]);
  for (const t of ['reception', 'adjustment', 'dispensation', 'sale', 'return', 'transfer_out', 'transfer_in', 'transfer_return']) assert.ok(allowed.includes(t), `${t} absent du CHECK`);
  const label = read('backend/src/routes/conformite.js').match(/const TYPE_LABEL = \{([^}]*)\}/)[1];
  for (const t of allowed) assert.ok(new RegExp(`\\b${t}:`).test(label), `${t} sans libellé dans le registre`);
  assert.ok(used.has('transfer_out'));
});

test('pointage : refusé à l\'Admin du groupe qui travaille dans une sous-pharmacie', () => {
  const src = read('backend/src/routes/rh.js');
  assert.match(src, /router\.get\('\/clock', notActing,/); assert.match(src, /router\.post\('\/clock', notActing,/);
  assert.match(src, /req\.user\.acting \? next\(new AppError\(403/);
});

/* ---------- 0.9.0 : réception partielle ---------- */
test('réception partielle : routes, statuts de la base, libellés serveur et interface alignés', () => {
  const src = read('backend/src/routes/transferts.js');
  const rcv = src.split("router.post('/:id/receive'")[1].split('\nrouter.')[0];
  assert.match(rcv, /planReceipt\(lots, req\.body\?\.received\)/); assert.match(rcv, /received_quantity = \$2/); assert.match(rcv, /shortfall_units = \$4/);
  assert.match(rcv, /qty: got\.get\(lot\.id\)/, 'seule la quantité réellement reçue entre en stock');
  const ret = src.split("router.post('/:id/return'")[1].split('\nrouter.')[0].split('\nmodule.exports')[0];
  assert.match(ret, /restockShipped\(c, req, t,[^\n]*partial\)/, 'reprise de l\'écart seul en cas de réception partielle');
  const sql = [...fs.readdirSync(path.join(ROOT, 'backend/db')).filter((f) => /^schema.*\.sql$/.test(f)).sort()].map((f) => read(`backend/db/${f}`)).join('\n');
  const checks = [...sql.matchAll(/stock_transfers_status_check\s+CHECK \(status IN \(([^)]*)\)\)/g)];
  const statuses = [...checks[checks.length - 1][1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();      // dernière définition = celle en vigueur
  const Tr2 = require('../src/lib/transfers');
  assert.deepEqual(Object.keys(Tr2.STATUS_LABEL).sort(), statuses, 'libellés serveur ↔ statuts de la base');
  const fe = read('frontend/js/app.js').match(/const TR_STATUS = \{([^\n]*)\};/)[1];
  assert.deepEqual([...fe.matchAll(/(\w+): \[/g)].map((m) => m[1]).sort(), statuses, 'libellés de l\'interface ↔ statuts de la base');
  for (const t of Object.values(Tr2.ACTIONS)) for (const s of t.from) assert.ok(statuses.includes(s), `statut ${s} des transitions absent de la base`);
});

/* ---------- 0.9.1 : dossiers de référence (directive d'optimisation des tokens) ---------- */
test('dossiers de référence : présents, à jour de la version, règles métier conservées', () => {
  const version = JSON.parse(read('package.json')).version;
  const files = ['CAHIER_DES_CHARGES.md', 'SUIVI_EXECUTION.md', 'ARCHITECTURE_TECHNIQUE.md', 'ETAT_ACTUEL.md', 'DIRECTIVE_AGENT.md'];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} manquant`);
  for (const f of ['ETAT_ACTUEL.md', 'SUIVI_EXECUTION.md', 'CAHIER_DES_CHARGES.md', 'ARCHITECTURE_TECHNIQUE.md']) assert.ok(read(f).includes(`Version : ${version}`) || read(f).includes(`Version du logiciel : ${version}`), `${f} : version ${version} non mentionnée (à actualiser)`);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${version.replace(/\./g, '\\.')}$`, 'm'), 'CHANGELOG sans entrée pour la version courante');
  assert.ok(read('README.md').includes(`v${version}`), 'README : version');
  for (const f of files) assert.ok(read('README.md').includes(f), `README ne référence pas ${f}`);
  const etat = read('ETAT_ACTUEL.md');
  for (const h of ['Dernière tâche effectuée', 'Principaux changements', 'Tests exécutés', 'Problèmes non résolus', 'Prochaine tâche']) assert.ok(etat.includes(`## ${h}`), `ETAT_ACTUEL : rubrique « ${h} » manquante`);
  const cahier = read('CAHIER_DES_CHARGES.md');
  for (const h of ['## A. Décisions validées', '## B. Choix par défaut', '## C. Hors périmètre', '### Contenu de la Phase 1', '### Contenu de la Phase 2', '### Contenu de la Phase 3', '### Contenu de la Phase 4', '### Contenu de la Phase 5',
    '### Pharmacies multi-sites (0.7.0)', '### Transferts de stock entre pharmacies du groupe (0.8.0)', '### Fuseaux horaires (0.6.4)', "### Modèle d'accès"]) assert.ok(cahier.split('\n').includes(h) || cahier.split('\n').some((l) => l.startsWith(`${h}`)), `CAHIER : rubrique « ${h} » manquante (règle métier perdue ?)`);
  for (const rule of ['Un site = une pharmacie', 'compte administrateur local unique', 'plusieurs gérants', 'uniquement par le gérant local', 'FEFO']) assert.ok(cahier.includes(rule), `CAHIER : règle « ${rule} » absente`);
  assert.ok(read('DIRECTIVE_AGENT.md').includes('ne jamais les modifier sans demande explicite'));
});
