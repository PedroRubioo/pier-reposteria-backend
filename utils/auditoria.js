// utils/auditoria.js — Registro de movimientos del equipo
//
// Escribe en core.tblauditoria quién hizo qué (productos, promociones,
// estados de pedido, avisos de demora, asignaciones...). Es "fuego y
// olvido": nunca rompe la operación principal si el registro falla.
const { pool } = require('../config/database');

// Medio emoji: un sustituto UTF-16 sin su pareja. JSON.stringify lo deja
// como "\ud83d" y jsonb rechaza la fila entera: se cambia por U+FFFD
const SUSTITUTO_SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REEMPLAZO = String.fromCodePoint(0xfffd);
const sinSustitutosSueltos = (_clave, valor) => (typeof valor === 'string' ? valor.replace(SUSTITUTO_SUELTO, REEMPLAZO) : valor);

// Texto libre recortado para `detalles` (Diseno_Bitacora.md §2). Se corta por
// caracteres completos: slice cuenta unidades UTF-16 y puede partir un emoji.
// Si hubo corte, tampoco queda al final una entidad del sanitizador a medias:
// el texto guardado trae "&amp;", "&#x2F;"... y "&am" ya no se puede decodificar
function recortar(texto, max) {
  const caracteres = Array.from(String(texto));
  if (caracteres.length <= max) return caracteres.join('');
  return caracteres.slice(0, max).join('').replace(/&[#\w]*$/, '');
}

async function registrarAuditoria({ usuario_id = null, accion, entidad = null, entidad_id = null, detalles = null, ip = null }) {
  try {
    // detalles es jsonb: node-pg manda el texto crudo y jsonb lo rechaza,
    // así que se serializa siempre (un texto queda como string JSON)
    await pool.query(
      `INSERT INTO core.tblauditoria (usuario_id, accion, entidad, entidad_id, detalles, ip, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())`,
      [usuario_id, accion, entidad, entidad_id, detalles === null ? null : JSON.stringify(detalles, sinSustitutosSueltos), ip ? String(ip).slice(0, 45) : null]
    );
  } catch (e) {
    console.error('Auditoría no registrada:', e.message);
  }
}

module.exports = { registrarAuditoria, recortar };
