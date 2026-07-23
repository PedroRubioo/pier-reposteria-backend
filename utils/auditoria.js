// utils/auditoria.js — Registro de movimientos del equipo
//
// Escribe en core.tblauditoria quién hizo qué (productos, promociones,
// estados de pedido, avisos de demora, asignaciones...). Es "fuego y
// olvido": nunca rompe la operación principal si el registro falla.
const { pool } = require('../config/database');

async function registrarAuditoria({ usuario_id = null, accion, entidad = null, entidad_id = null, detalles = null }) {
  try {
    await pool.query(
      `INSERT INTO core.tblauditoria (usuario_id, accion, entidad, entidad_id, detalles, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [usuario_id, accion, entidad, entidad_id, detalles]
    );
  } catch (e) {
    console.error('Auditoría no registrada:', e.message);
  }
}

module.exports = { registrarAuditoria };
