// utils/auditoria.js — Registro de movimientos del equipo
//
// Escribe en core.tblauditoria quién hizo qué (productos, promociones,
// estados de pedido, avisos de demora, asignaciones...). Es "fuego y
// olvido": nunca rompe la operación principal si el registro falla.
const { pool } = require('../config/database');

async function registrarAuditoria({ usuario_id = null, accion, entidad = null, entidad_id = null, detalles = null, ip = null }) {
  try {
    // detalles es jsonb: node-pg manda el texto crudo y jsonb lo rechaza,
    // así que se serializa siempre (un texto queda como string JSON)
    await pool.query(
      `INSERT INTO core.tblauditoria (usuario_id, accion, entidad, entidad_id, detalles, ip, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())`,
      [usuario_id, accion, entidad, entidad_id, detalles === null ? null : JSON.stringify(detalles), ip ? String(ip).slice(0, 45) : null]
    );
  } catch (e) {
    console.error('Auditoría no registrada:', e.message);
  }
}

module.exports = { registrarAuditoria };
