// routes/recomendacionesRoutes.js — Recomendaciones de productos
//
// Productos afines por filtrado colaborativo ítem-ítem sobre los pedidos
// reales. El cálculo de similitud (y su caché en memoria) vive en
// utils/recomendaciones.js: lo comparten esta ruta y las sugerencias del
// feed del inicio del cliente.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { obtenerSimilares } = require('../utils/recomendaciones');

// GET /api/recomendaciones/:productoId → top 3 productos afines (resueltos
// contra el catálogo: solo activos y con stock). Si el producto tiene poco
// historial, fallback a los más vendidos de otra categoría (afinidad null).
router.get('/:productoId', async (req, res) => {
  try {
    const productoId = parseInt(req.params.productoId);
    if (isNaN(productoId)) return res.status(400).json({ success: false, message: 'Producto inválido' });

    const similares = await obtenerSimilares();
    const candidatos = (similares.get(productoId) || []).slice(0, 12);

    const recomendaciones = [];
    if (candidatos.length > 0) {
      const prods = await pool.query(`
        SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, p.stock_online, c.nombre AS categoria
        FROM core.tblproductos p
        JOIN core.tblcategorias c ON c.id = p.categoria_id
        WHERE p.id = ANY($1) AND p.activo = true AND c.activo = true AND p.stock_online > 0
      `, [candidatos.map(c => c.id)]);
      const porId = new Map(prods.rows.map(r => [r.id, r]));
      for (const candidato of candidatos) {
        const prod = porId.get(candidato.id);
        if (!prod) continue;
        recomendaciones.push({ ...prod, afinidad: Math.round(candidato.score * 100) });
        if (recomendaciones.length >= 3) break;
      }
    }

    if (recomendaciones.length < 3) {
      const catRes = await pool.query('SELECT categoria_id FROM core.tblproductos WHERE id = $1', [productoId]);
      const categoriaId = catRes.rows.length > 0 ? catRes.rows[0].categoria_id : null;
      const excluidos = [productoId, ...recomendaciones.map(r => r.id)];
      const top = await pool.query(`
        SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, p.stock_online, c.nombre AS categoria,
               COALESCE(SUM(CASE WHEN pe.id IS NOT NULL THEN i.cantidad ELSE 0 END), 0) AS vendidos
        FROM core.tblproductos p
        JOIN core.tblcategorias c ON c.id = p.categoria_id
        LEFT JOIN core.tblpedido_items i ON i.producto_id = p.id
        LEFT JOIN core.tblpedidos pe ON pe.id = i.pedido_id AND pe.estado IN ('completado', 'entregado')
        WHERE p.activo = true AND c.activo = true AND p.stock_online > 0
          AND p.id <> ALL($1) AND ($2::int IS NULL OR p.categoria_id <> $2)
        GROUP BY p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, p.stock_online, c.nombre
        ORDER BY vendidos DESC
        LIMIT $3
      `, [excluidos, categoriaId, 3 - recomendaciones.length]);
      for (const fila of top.rows) {
        const { vendidos, ...prod } = fila;
        void vendidos;
        recomendaciones.push({ ...prod, afinidad: null });
      }
    }

    res.json({ success: true, recomendaciones });
  } catch (error) {
    console.error('Error GET /recomendaciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener recomendaciones' });
  }
});

module.exports = router;
