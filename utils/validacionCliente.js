// utils/validacionCliente.js — Validación campo por campo de lo que escribe el cliente
//
// Las rutas del cliente que salen del sanitizador (middleware/validation.js,
// Diseno_Panel_Cliente.md §5.1) validan aquí cada campo. Regla (§5.0): solo
// se rechaza lo que hoy termina en 500 (más largo que la columna, fuera del
// enum, tipo equivocado) o lo que se guarda inservible. Los mínimos y topes
// de los formularios web no se imponen aquí: la app no los aplica.

const MAX_INTEGER = 2147483647;

// Caracteres de control salvo el salto de línea (C0, DEL y C1)
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g; // eslint-disable-line no-control-regex

/**
 * Texto libre: string, sin caracteres de control (salvo \n), recortado y con
 * máximo 2 saltos seguidos; el largo se mide en puntos de código. Sin `max`,
 * sin tope. Con `opcional`, ausente o vacío da `valor: null`.
 * @returns {{ ok: true, valor: string | null } | { ok: false }}
 */
function textoLibre(valor, { min = 0, max = Infinity, opcional = false } = {}) {
  if (valor === undefined || valor === null) return opcional ? { ok: true, valor: null } : { ok: false };
  if (typeof valor !== 'string') return { ok: false };
  const limpio = valor
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(/[  ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const largo = Array.from(limpio).length;
  if (largo === 0 && opcional) return { ok: true, valor: null };
  if (largo < min || largo > max) return { ok: false };
  return { ok: true, valor: limpio };
}

/** Entero positivo que cabe en INTEGER (acepta "12"). null si no lo es */
function enteroPositivo(valor) {
  let n;
  if (typeof valor === 'number') n = valor;
  else if (typeof valor === 'string' && /^\d{1,10}$/.test(valor)) n = Number(valor);
  else return null;
  return Number.isInteger(n) && n > 0 && n <= MAX_INTEGER ? n : null;
}

/** URL de Cloudinary de la cuenta del proyecto */
function esUrlCloudinary(url) {
  const nube = process.env.CLOUDINARY_CLOUD_NAME;
  return typeof url === 'string' && !!nube && url.startsWith(`https://res.cloudinary.com/${nube}/`);
}

/**
 * Teléfono de 10 dígitos: quita todo lo que no sea dígito (espacios, guiones,
 * «+», paréntesis, puntos); 12 dígitos que empiezan con 52 dejan los últimos
 * 10. Vacío o solo espacios (o null) da `valor: null`.
 * @returns {{ ok: true, valor: string | null } | { ok: false }}
 */
function telefono10(valor) {
  if (valor === undefined || valor === null) return { ok: true, valor: null };
  if (typeof valor !== 'string' && typeof valor !== 'number') return { ok: false };
  const texto = String(valor);
  if (texto.trim() === '') return { ok: true, valor: null };
  let digitos = texto.replace(/\D/g, '');
  if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
  return digitos.length === 10 ? { ok: true, valor: digitos } : { ok: false };
}

/** Minúsculas, sin acentos (la «ñ» queda «n»), espacios simples y sin espacios en los extremos */
function normalizarClave(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** La misma normalización en SQL, para comparar colonias (lower() ya baja las mayúsculas acentuadas) */
function coloniaNormalizadaSql(columna) {
  return `regexp_replace(translate(lower(trim(${columna})), 'áéíóúüñ', 'aeiouun'), '\\s+', ' ', 'g')`;
}

module.exports = { textoLibre, enteroPositivo, esUrlCloudinary, telefono10, normalizarClave, coloniaNormalizadaSql };
