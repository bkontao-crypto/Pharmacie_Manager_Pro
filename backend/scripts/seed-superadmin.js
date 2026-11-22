'use strict';
// Crée le compte Superadmin initial (SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD). Sans effet s'il en existe déjà un.
const bcrypt = require('bcryptjs');
const { tx, pool } = require('../src/db');
const v = require('../src/lib/validate');

async function seed(emailRaw, passwordRaw) {
  const email = v.email(emailRaw); const password = v.password(passwordRaw);
  return tx({ system: true }, async (c) => {
    if ((await c.query(`SELECT 1 FROM users WHERE role = 'superadmin'`)).rowCount) return false;
    await c.query(
      `INSERT INTO users (tenant_id, email, full_name, role, password_hash, must_change_password)
       VALUES (NULL,$1,'Super Administrateur','superadmin',$2,true)`, [email, await bcrypt.hash(password, 12)]);
    return true;
  });
}
module.exports = { seed };

if (require.main === module) {
  seed(process.env.SUPERADMIN_EMAIL, process.env.SUPERADMIN_PASSWORD)
    .then((created) => { console.log(created ? `Superadmin créé : ${process.env.SUPERADMIN_EMAIL} (changement de mot de passe exigé à la 1re connexion)` : 'Un Superadmin existe déjà — rien à faire.'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
