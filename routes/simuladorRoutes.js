// routes/simuladorRoutes.js — Simulador de producción con datos reales
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Productos ordenados por más vendidos (total histórico)
router.get('/productos-ranking', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, c.nombre AS categoria,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS total_vendido,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos_totales
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblpedido_items pi ON pi.producto_id = p.id
      LEFT JOIN core.tblpedidos pd ON pi.pedido_id = pd.id AND pd.estado NOT IN ('cancelado')
      WHERE p.activo = true
      GROUP BY p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, c.nombre
      ORDER BY total_vendido DESC
    `);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /simulador/productos-ranking:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener ranking' });
  }
});

// Ventas mensuales de un producto (últimos 6 meses)
router.get('/ventas-mensuales/:productoId', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { productoId } = req.params;
    const meses = parseInt(req.query.meses) || 6;

    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', pd.created_at), 'YYYY-MM') AS mes,
        TO_CHAR(DATE_TRUNC('month', pd.created_at), 'Mon YYYY') AS mes_label,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos pd ON pi.pedido_id = pd.id
      WHERE pi.producto_id = $1
        AND pd.estado NOT IN ('cancelado')
        AND pd.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${meses} months'
      GROUP BY DATE_TRUNC('month', pd.created_at)
      ORDER BY mes ASC
    `, [productoId]);

    // Rellenar meses vacíos
    const ventasPorMes = [];
    const ahora = new Date();
    for (let i = meses - 1; i >= 0; i--) {
      const fecha = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
      const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
      const mesLabel = fecha.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });
      const encontrado = result.rows.find(r => r.mes === mesKey);
      ventasPorMes.push({
        mes: mesKey,
        mes_label: mesLabel,
        unidades: encontrado ? parseInt(encontrado.unidades) : 0,
        ingresos: encontrado ? parseFloat(encontrado.ingresos) : 0,
      });
    }

    // Predicción simple: promedio de los últimos 3 meses con tendencia
    const ultimos3 = ventasPorMes.slice(-3).map(v => v.unidades);
    const promedio = ultimos3.reduce((a, b) => a + b, 0) / (ultimos3.length || 1);

    // Tendencia: diferencia entre último y penúltimo
    const tendencia = ultimos3.length >= 2 ? ultimos3[ultimos3.length - 1] - ultimos3[ultimos3.length - 2] : 0;
    const prediccion = Math.max(0, Math.round(promedio + tendencia * 0.5));

    // Obtener precio para calcular ingreso estimado
    const productoInfo = await pool.query('SELECT precio_chico FROM core.tblproductos WHERE id = $1', [productoId]);
    const precio = productoInfo.rows[0] ? parseFloat(productoInfo.rows[0].precio_chico) : 0;

    res.json({
      success: true,
      ventas_mensuales: ventasPorMes,
      prediccion: {
        unidades: prediccion,
        ingresos_estimados: Math.round(prediccion * precio),
        tendencia: tendencia > 0 ? 'subiendo' : tendencia < 0 ? 'bajando' : 'estable',
        tendencia_valor: tendencia,
      },
      resumen: {
        total_unidades: ventasPorMes.reduce((a, v) => a + v.unidades, 0),
        total_ingresos: ventasPorMes.reduce((a, v) => a + v.ingresos, 0),
        promedio_mensual: Math.round(promedio),
      }
    });
  } catch (error) {
    console.error('Error GET /simulador/ventas-mensuales:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener ventas' });
  }
});

module.exports = router;
