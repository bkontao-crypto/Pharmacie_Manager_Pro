'use strict';
// Charge une base d'interactions/classes GLOBALE (toutes pharmacies) : npm run import-reference -- fichier.json
// Format : { "source": "…", "classes": [{substance, class}], "rules": [{termA, termB, severity, description, recommendation}] }
// Un jeu d'EXEMPLE non validé est fourni dans backend/data/reference.sample.json : à ne pas utiliser comme source clinique.
const fs = require('fs');
const { tx } = require('../src/db');
const { importReference } = require('../src/lib/reference');
(async () => {
  const f = process.argv[2]; if (!f) throw new Error('Usage : npm run import-reference -- <fichier.json>');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!d.source || String(d.source).length < 3) throw new Error('Le fichier doit déclarer sa "source" (origine et version de la base)');
  const r = await tx({ system: true }, (c) => importReference(c, { tenantId: null, source: d.source, rules: d.rules || [], classes: d.classes || [] }));
  console.log(`Importé : ${r.rules} règle(s), ${r.classes} classe(s). Source : ${d.source}`);
  r.errors.forEach((e) => console.log(`  ignoré (${e.kind} ${e.line}) : ${e.message}`));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
