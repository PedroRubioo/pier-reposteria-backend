// routes/carritoRoutes.js — Carrito (corregido al schema real)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

// Listar items del carrito (con descuentos de promociones activas)
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await pool.query(`
      SELECT
        ci.id AS carrito_item_id, ci.cantidad, ci.tamano, ci.created_at AS agregado_el,
        p.id AS producto_id, p.nombre, p.descripcion, p.precio_chico, p.precio_grande,
        p.imagen_url, p.stock_online, p.activo,
        c.nombre AS categoria,
        CASE WHEN ci.tamano = 'grande' AND p.precio_grande IS NOT NULL THEN p.precio_grande ELSE p.precio_chico END AS precio_unitario,
        pr.descuento_porcentaje AS promo_descuento, pr.precio_oferta AS promo_precio_oferta, pr.tipo AS promo_tipo, pr.nombre_temporada AS promo_nombre
      FROM core.tblcarrito_items ci
      JOIN core.tblproductos p ON ci.producto_id = p.id
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblpromociones pr ON pr.producto_id = p.id AND pr.estado = 'activa' AND (pr.fecha_fin IS NULL OR pr.fecha_fin > NOW())
      WHERE ci.usuario_id = $1
      ORDER BY ci.created_at DESC
    `, [userId]);

    const items = result.rows.map(i => {
      const precioBase = parseFloat(i.precio_unitario);
      let precioFinal = precioBase;
      if (i.promo_descuento) precioFinal = Math.round(precioBase * (1 - parseFloat(i.promo_descuento) / 100));
      return {
        ...i,
        precio_original: precioBase,
        precio_unitario: precioFinal,
        subtotal: precioFinal * i.cantidad,
        tiene_descuento: precioFinal < precioBase,
      };
    });
    const total = items.reduce((sum, i) => sum + i.subtotal, 0);
    const total_items = items.reduce((sum, i) => sum + i.cantidad, 0);

    res.json({ success: true, carrito: { items, total: Math.round(total * 100) / 100, total_items } });
  } catch (error) {
    console.error('Error GET /carrito:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener carrito' });
  }
});

// Count (para badge)
router.get('/count', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT COALESCE(SUM(cantidad), 0)::INTEGER AS total FROM core.tblcarrito_items WHERE usuario_id = $1', [req.user.userId]);
    res.json({ success: true, count: result.rows[0].total });
  } catch (error) {
    console.error('Error GET /carrito/count:', error.message);
    res.status(500).json({ success: false, message: 'Error al contar items' });
  }
});

// Agregar al carrito
router.post('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { producto_id, cantidad, tamano } = req.body;

    if (!producto_id || !cantidad || cantidad < 1) {
      return res.status(400).json({ success: false, message: 'Producto y cantidad son requeridos' });
    }

    const producto = await pool.query('SELECT id, nombre, stock_online, activo FROM core.tblproductos WHERE id = $1', [producto_id]);
    if (producto.rows.length === 0 || !producto.rows[0].activo) {
      return res.status(404).json({ success: false, message: 'Producto no disponible' });
    }
    if (producto.rows[0].stock_online > 0 && producto.rows[0].stock_online < cantidad) {
      return res.status(400).json({ success: false, message: `Solo quedan ${producto.rows[0].stock_online} unidades` });
    }

    // Si ya existe con mismo tamaño, sumar cantidad
    const existe = await pool.query(
      'SELECT id, cantidad FROM core.tblcarrito_items WHERE usuario_id = $1 AND producto_id = $2 AND tamano = $3',
      [userId, producto_id, tamano || 'chico']
    );

    if (existe.rows.length > 0) {
      const nueva = existe.rows[0].cantidad + cantidad;
      if (producto.rows[0].stock_online > 0 && producto.rows[0].stock_online < nueva) {
        return res.status(400).json({ success: false, message: `Solo quedan ${producto.rows[0].stock_online} unidades` });
      }
      await pool.query('UPDATE core.tblcarrito_items SET cantidad = $1, updated_at = NOW() WHERE id = $2', [nueva, existe.rows[0].id]);
      res.json({ success: true, message: `Cantidad actualizada a ${nueva}` });
    } else {
      await pool.query(
        'INSERT INTO core.tblcarrito_items (usuario_id, producto_id, cantidad, tamano, created_at, updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())',
        [userId, producto_id, cantidad, tamano || 'chico']
      );
      res.status(201).json({ success: true, message: `"${producto.rows[0].nombre}" agregado al carrito` });
    }
  } catch (error) {
    console.error('Error POST /carrito:', error.message);
    res.status(500).json({ success: false, message: 'Error al agregar al carrito' });
  }
});

// Actualizar cantidad
router.put('/:itemId', verifyToken, async (req, res) => {
  try {
    const { cantidad } = req.body;
    if (!cantidad || cantidad < 1) return res.status(400).json({ success: false, message: 'Cantidad debe ser al menos 1' });

    const item = await pool.query(
      `SELECT ci.id, p.stock_online FROM core.tblcarrito_items ci JOIN core.tblproductos p ON ci.producto_id = p.id WHERE ci.id = $1 AND ci.usuario_id = $2`,
      [req.params.itemId, req.user.userId]
    );
    if (item.rows.length === 0) return res.status(404).json({ success: false, message: 'Item no encontrado' });
    if (item.rows[0].stock_online > 0 && item.rows[0].stock_online < cantidad) {
      return res.status(400).json({ success: false, message: `Solo quedan ${item.rows[0].stock_online} unidades` });
    }

    await pool.query('UPDATE core.tblcarrito_items SET cantidad = $1, updated_at = NOW() WHERE id = $2', [cantidad, req.params.itemId]);
    res.json({ success: true, message: 'Cantidad actualizada' });
  } catch (error) {
    console.error('Error PUT /carrito/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar' });
  }
});

// Eliminar item
router.delete('/:itemId', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblcarrito_items WHERE id = $1 AND usuario_id = $2 RETURNING id', [req.params.itemId, req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Item no encontrado' });
    res.json({ success: true, message: 'Item eliminado' });
  } catch (error) {
    console.error('Error DELETE /carrito/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar' });
  }
});

// Vaciar carrito
router.delete('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblcarrito_items WHERE usuario_id = $1', [req.user.userId]);
    res.json({ success: true, message: `Carrito vaciado (${result.rowCount} items)` });
  } catch (error) {
    console.error('Error DELETE /carrito:', error.message);
    res.status(500).json({ success: false, message: 'Error al vaciar carrito' });
  }
});

module.exports = router;