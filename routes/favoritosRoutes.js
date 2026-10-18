// routes/favoritosRoutes.js — Favoritos (cliente autenticado)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { enteroPositivo } = require('../utils/validacionCliente');

// Listar favoritos con datos del producto. Un producto de una categoría
// oculta se trata como uno dado de baja: no se puede comprar
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        f.id AS favorito_id, f.created_at AS agregado_el,
        p.id, p.nombre, p.descripcion, p.precio_chico, p.precio_grande,
        p.imagen_url, p.sabor, p.tipo, p.stock_online, p.es_nuevo,
        c.nombre AS categoria,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS rating,
        COUNT(DISTINCT r.id)::INTEGER AS reviews
      FROM core.tblfavoritos f
      JOIN core.tblproductos p ON f.producto_id = p.id
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblresenas r ON r.producto_id = p.id AND r.estado = 'aprobada'
      WHERE f.usuario_id = $1 AND p.activo = true AND c.activo = TRUE
      GROUP BY f.id, p.id, c.nombre
      ORDER BY f.created_at DESC
    `, [req.user.userId]);

    res.json({ success: true, favoritos: result.rows });
  } catch (error) {
    console.error('Error GET /favoritos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener favoritos' });
  }
});

// Solo IDs (para marcar corazones rápido)
router.get('/ids', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT producto_id FROM core.tblfavoritos WHERE usuario_id = $1', [req.user.userId]);
    res.json({ success: true, ids: result.rows.map(r => r.producto_id) });
  } catch (error) {
    console.error('Error GET /favoritos/ids:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener IDs' });
  }
});

// Agregar a favoritos. Un doble clic ya no choca con el índice único
router.post('/:productoId', verifyToken, async (req, res) => {
  try {
    const productoId = enteroPositivo(req.params.productoId);
    const producto = productoId
      ? await pool.query('SELECT 1 FROM core.tblproductos WHERE id = $1 AND activo = TRUE', [productoId])
      : { rows: [] };
    if (producto.rows.length === 0) return res.status(404).json({ success: false, message: 'Producto no disponible' });

    const insertado = await pool.query(
      `INSERT INTO core.tblfavoritos (usuario_id, producto_id, created_at) VALUES ($1, $2, NOW())
       ON CONFLICT (usuario_id, producto_id) DO NOTHING RETURNING id`,
      [req.user.userId, productoId]
    );
    if (insertado.rows.length === 0) return res.json({ success: true, message: 'Ya está en favoritos' });
    res.status(201).json({ success: true, message: 'Agregado a favoritos' });
  } catch (error) {
    console.error('Error POST /favoritos:', error.message);
    res.status(500).json({ success: false, message: 'Error al agregar favorito' });
  }
});

// Eliminar de favoritos
router.delete('/:productoId', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblfavoritos WHERE usuario_id = $1 AND producto_id = $2 RETURNING id', [req.user.userId, req.params.productoId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado en favoritos' });
    res.json({ success: true, message: 'Eliminado de favoritos' });
  } catch (error) {
    console.error('Error DELETE /favoritos:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar favorito' });
  }
});

module.exports = router;