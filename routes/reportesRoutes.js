// routes/reportesRoutes.js — Reportes (lee vistas del esquema reports)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Listar vistas disponibles
router.get('/vistas', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name AS vista FROM information_schema.views WHERE table_schema = 'reports' ORDER BY table_name
    `);
    res.json({ success: true, vistas: result.rows.map(r => r.vista) });
  } catch (error) {
    console.error('Error GET /reportes/vistas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener vistas' });
  }
});

// Ejecutar vista específica
router.get('/vista/:nombre', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre } = req.params;
    // Validar que la vista existe en schema reports
    const existe = await pool.query(
      "SELECT 1 FROM information_schema.views WHERE table_schema = 'reports' AND table_name = $1", [nombre]
    );
    if (existe.rows.length === 0) return res.status(404).json({ success: false, message: 'Vista no encontrada' });

    const result = await pool.query(`SELECT * FROM reports.${nombre}`);
    res.json({ success: true, vista: nombre, datos: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error GET /reportes/vista/:nombre:', error.message);
    res.status(500).json({ success: false, message: 'Error al ejecutar vista' });
  }
});

// Dashboard KPIs rápidos
router.get('/kpis', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const [ingresos, pedidos, clientes, productos] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(monto_total), 0)::NUMERIC(10,2) AS total FROM core.tblpagos WHERE estado = 'pagado'"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblpedidos"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblusuarios WHERE rol = 'cliente' AND activo = true"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblproductos WHERE activo = true")
    ]);
    res.json({
      success: true,
      kpis: {
        ingresos_total: parseFloat(ingresos.rows[0].total),
        pedidos_total: parseInt(pedidos.rows[0].total),
        clientes_activos: parseInt(clientes.rows[0].total),
        productos_activos: parseInt(productos.rows[0].total)
      }
    });
  } catch (error) {
    console.error('Error GET /reportes/kpis:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener KPIs' });
  }
});

// Auditoría
router.get('/auditoria', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { limite } = req.query;
    const result = await pool.query(`
      SELECT a.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
      FROM core.tblauditoria a
      LEFT JOIN core.tblusuarios u ON a.usuario_id = u.id
      ORDER BY a.created_at DESC LIMIT $1
    `, [parseInt(limite) || 50]);
    res.json({ success: true, auditoria: result.rows });
  } catch (error) {
    console.error('Error GET /reportes/auditoria:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener auditoría' });
  }
});

module.exports = router;