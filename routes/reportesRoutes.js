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

// ── Actividad del equipo (solo dirección general) ──
// Todo calculado en vivo: quién está activo, qué movimientos registró
// cada quien (auditoría de negocio), entregas por repartidor, zonas con
// más envíos y avisos de demora.
const ACCIONES_TECNICAS = ['EXPLAIN ANALYZE', 'Prueba de acceso BD', 'Configuración de seguridad BD'];

router.get('/actividad-equipo', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const [equipoR, accionesR, entregasR, movimientosR, zonasR, kpisR] = await Promise.all([
      pool.query(`SELECT id, nombre, apellido, rol, activo, ultimo_acceso
                  FROM core.tblusuarios WHERE rol IN ('empleado', 'gerencia', 'repartidor') ORDER BY rol, nombre`),
      pool.query(`SELECT usuario_id, COUNT(*)::int AS acciones, MAX(created_at) AS ultima_accion
                  FROM core.tblauditoria
                  WHERE usuario_id IS NOT NULL AND accion <> ALL($1)
                  GROUP BY usuario_id`, [ACCIONES_TECNICAS]),
      pool.query(`SELECT repartidor_id,
                         COUNT(*) FILTER (WHERE estado = 'entregada')::int AS entregadas,
                         COUNT(*) FILTER (WHERE estado IN ('asignada', 'en_camino'))::int AS activas
                  FROM core.tblentregas GROUP BY repartidor_id`),
      pool.query(`SELECT a.accion, a.entidad, a.detalles, a.created_at, u.nombre, u.apellido, u.rol
                  FROM core.tblauditoria a LEFT JOIN core.tblusuarios u ON u.id = a.usuario_id
                  WHERE a.accion <> ALL($1)
                  ORDER BY a.created_at DESC LIMIT 30`, [ACCIONES_TECNICAS]),
      pool.query(`SELECT direccion_entrega->>'zona' AS zona, direccion_entrega->>'colonia' AS colonia, COUNT(*)::int AS pedidos
                  FROM core.tblpedidos
                  WHERE tipo_entrega = 'domicilio' AND direccion_entrega IS NOT NULL AND estado <> 'cancelado'
                  GROUP BY 1, 2 ORDER BY pedidos DESC LIMIT 8`),
      pool.query(`SELECT
                    (SELECT COUNT(*)::int FROM core.tblnotificaciones WHERE titulo = 'Tu pedido tardará un poco más') AS avisos_demora,
                    (SELECT COUNT(DISTINCT usuario_id)::int FROM core.tblpedidos WHERE created_at > NOW() - INTERVAL '30 days' AND estado <> 'cancelado') AS clientes_atendidos_30d,
                    (SELECT COUNT(*)::int FROM core.tblpedidos WHERE created_at > NOW() - INTERVAL '30 days' AND estado IN ('completado', 'entregado')) AS pedidos_cerrados_30d,
                    (SELECT COUNT(*)::int FROM core.tblproductos WHERE updated_at > NOW() - INTERVAL '30 days') AS productos_movidos_30d,
                    (SELECT COUNT(*)::int FROM core.tblpromociones WHERE created_at > NOW() - INTERVAL '30 days') AS promos_creadas_30d`),
    ]);

    const accionesPor = new Map(accionesR.rows.map(r => [r.usuario_id, r]));
    const entregasPor = new Map(entregasR.rows.map(r => [r.repartidor_id, r]));
    const equipo = equipoR.rows.map(u => ({
      ...u,
      acciones: accionesPor.get(u.id)?.acciones || 0,
      ultima_accion: accionesPor.get(u.id)?.ultima_accion || null,
      entregadas: entregasPor.get(u.id)?.entregadas || 0,
      entregas_activas: entregasPor.get(u.id)?.activas || 0,
    }));

    res.json({ success: true, equipo, movimientos: movimientosR.rows, zonas: zonasR.rows, kpis: kpisR.rows[0] });
  } catch (error) {
    console.error('Error GET /reportes/actividad-equipo:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener la actividad del equipo' });
  }
});

module.exports = router;