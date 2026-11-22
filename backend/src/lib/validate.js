'use strict';
const { AppError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const str = (v, { min = 1, max = 200, field = 'champ' } = {}) => {
  if (typeof v !== 'string') throw new AppError(400, `${field} requis`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new AppError(400, `${field} : entre ${min} et ${max} caractères`);
  return t;
};
const optStr = (v, opts) => (v === undefined || v === null || v === '' ? null : str(v, opts));
const email = (v, field = 'email') => {
  const t = str(v, { max: 254, field }).toLowerCase();
  if (!EMAIL_RE.test(t)) throw new AppError(400, `${field} invalide`);
  return t;
};
const oneOf = (v, list, field = 'valeur') => {
  if (!list.includes(v)) throw new AppError(400, `${field} invalide (${list.join(', ')})`);
  return v;
};
const stringArray = (v, field = 'liste') => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new AppError(400, `${field} doit être un tableau de chaînes`);
  return [...new Set(v)];
};
const uuid = (v, field = 'id') => {
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new AppError(400, `${field} invalide`);
  return v;
};
const date = (v, field = 'date') => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new AppError(400, `${field} invalide (AAAA-MM-JJ)`);
  return v;
};
/** Politique mot de passe : ≥ 10 caractères, au moins une lettre et un chiffre. */
const password = (v, field = 'mot de passe') => {
  if (typeof v !== 'string' || v.length < 10 || v.length > 128 || !/[A-Za-z]/.test(v) || !/\d/.test(v)) {
    throw new AppError(400, `${field} : 10 caractères minimum, avec au moins une lettre et un chiffre`);
  }
  return v;
};
const int = (v, { min = 0, max = 1000000, field = 'nombre' } = {}) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new AppError(400, `${field} : entier entre ${min} et ${max}`);
  return v;
};
const money = (v, field = 'montant') => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) throw new AppError(400, `${field} invalide`);
  return Math.round(v * 100) / 100;
};
const bool = (v, field = 'valeur') => { if (typeof v !== 'boolean') throw new AppError(400, `${field} : booléen requis`); return v; };
const time = (v, field = 'heure') => {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new AppError(400, `${field} invalide (HH:MM)`);
  return v;
};
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

module.exports = { time, int, money, bool, str, optStr, email, oneOf, stringArray, uuid, date, password, slugify };
