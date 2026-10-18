// routes/carritoRoutes.js — Carrito (corregido al schema real)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { enteroPositivo } = require('../utils/validacionCliente');
const { JOIN_PROMO_VIGENTE, precioConPromocion } = require('../utils/promociones');

const TAMANOS = ['chico', 'grande'];
// chk_carrito_items_cantidad: un renglón (producto y tamaño) admite de 1 a 100
const MSG_TOPE_RENGLON = 'Puedes llevar hasta 100 piezas de un mismo producto y tamaño';
const esTopeRenglon = (error) => error.code === '23514' && error.constraint === 'chk_carrito_items_cantidad';

// Qué le impide al renglón pasar al pago (Diseno_Panel_Cliente.md §5.4). La
// existencia se compara con todos los tamaños del producto en el carrito
function problemaDelRenglon(i) {
  if (!i.activo || !i.categoria_activa) return 'no_disponible';
  if (i.stock_online === 0) return 'agotado';
  if (i.stock_online < i.cantidad_producto) return 'insuficiente';
  return null;
}

// Piezas en el carrito del usuario (el globo del encabezado)
async function contarCarrito(db, userId) {
  const r = await db.query('SELECT COALESCE(SUM(cantidad), 0)::INTEGER AS total FROM core.tblcarrito_items WHERE usuario_id = $1', [userId]);
  return r.rows[0].total;
}

// Listar items del carrito (con la promoción vigente que se cobra)
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await pool.query(`
      SELECT
        ci.id AS carrito_item_id, ci.cantidad, ci.tamano, ci.created_at AS agregado_el,
        p.id AS producto_id, p.nombre, p.descripcion, p.precio_chico, p.precio_grande,
        p.imagen_url, p.stock_online, p.activo, c.activo AS categoria_activa,
        c.nombre AS categoria,
        CASE WHEN ci.tamano = 'grande' AND p.precio_grande IS NOT NULL THEN p.precio_grande ELSE p.precio_chico END AS precio_unitario,
        pr.descuento_porcentaje AS promo_descuento, pr.precio_oferta AS promo_precio_oferta, pr.tipo AS promo_tipo, pr.nombre_temporada AS promo_nombre,
        SUM(ci.cantidad) OVER (PARTITION BY ci.producto_id)::int AS cantidad_producto
      FROM core.tblcarrito_items ci
      JOIN core.tblproductos p ON ci.producto_id = p.id
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      ${JOIN_PROMO_VIGENTE}
      WHERE ci.usuario_id = $1
      ORDER BY ci.created_at DESC
    `, [userId]);

    const items = result.rows.map(i => {
      const precioBase = parseFloat(i.precio_unitario);
      const precioFinal = precioConPromocion(precioBase, i.promo_descuento);
      return {
        ...i,
        precio_original: precioBase,
        precio_unitario: precioFinal,
        subtotal: precioFinal * i.cantidad,
        tiene_descuento: precioFinal < precioBase,
        disponibles: i.stock_online,
        problema: problemaDelRenglon(i),
      };
    });
    const total = items.reduce((sum, i) => sum + i.subtotal, 0);
    const total_items = items.reduce((sum, i) => sum + i.cantidad, 0);

    res.json({
      success: true,
      carrito: { items, total: Math.round(total * 100) / 100, total_items, hay_problemas: items.some(i => i.problema !== null) },
    });
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

// Agregar al carrito. El producto se bloquea mientras se suma: dos clics
// seguidos se forman y la existencia cuenta todos los tamaños del producto
router.post('/', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const productoId = enteroPositivo(req.body.producto_id);
  const cantidad = enteroPositivo(req.body.cantidad);
  const tamano = req.body.tamano === undefined || req.body.tamano === null || req.body.tamano === '' ? 'chico' : req.body.tamano;
  if (!productoId) return res.status(400).json({ success: false, message: 'Producto y cantidad son requeridos' });
  if (!cantidad) return res.status(400).json({ success: false, message: 'La cantidad debe ser un número entero mayor que 0' });
  if (!TAMANOS.includes(tamano)) return res.status(400).json({ success: false, message: 'Tamaño no válido' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const producto = await client.query(
      `SELECT p.id, p.nombre, p.stock_online, p.activo, p.precio_grande, c.activo AS categoria_activa
         FROM core.tblproductos p JOIN core.tblcategorias c ON c.id = p.categoria_id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [productoId]
    );
    const p = producto.rows[0];
    if (!p || !p.activo || !p.categoria_activa) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Producto no disponible' });
    }
    if (tamano === 'grande' && p.precio_grande === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Este producto solo tiene un tamaño' });
    }
    // stock_online = 0 significa agotado (no existe stock ilimitado)
    if (p.stock_online === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `"${p.nombre}" está agotado` });
    }
    const enCarrito = await client.query(
      'SELECT COALESCE(SUM(cantidad), 0)::int AS en_carrito FROM core.tblcarrito_items WHERE usuario_id = $1 AND producto_id = $2',
      [userId, productoId]
    );
    if (enCarrito.rows[0].en_carrito + cantidad > p.stock_online) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Solo quedan ${p.stock_online} unidades` });
    }

    const renglon = await client.query(
      `INSERT INTO core.tblcarrito_items (usuario_id, producto_id, cantidad, tamano, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (usuario_id, producto_id, tamano)
       DO UPDATE SET cantidad = core.tblcarrito_items.cantidad + EXCLUDED.cantidad, updated_at = NOW()
       RETURNING cantidad, (xmax = 0) AS nuevo`,
      [userId, productoId, cantidad, tamano]
    );
    const count = await contarCarrito(client, userId);
    await client.query('COMMIT');

    const { cantidad: nueva, nuevo } = renglon.rows[0];
    if (nuevo) return res.status(201).json({ success: true, message: `"${p.nombre}" agregado al carrito`, count });
    res.json({ success: true, message: `Cantidad actualizada a ${nueva}`, count });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (esTopeRenglon(error)) return res.status(400).json({ success: false, message: MSG_TOPE_RENGLON });
    console.error('Error POST /carrito:', error.message);
    res.status(500).json({ success: false, message: 'Error al agregar al carrito' });
  } finally {
    if (client) client.release();
  }
});

// Actualizar cantidad: los otros tamaños del producto más la nueva cantidad
// no pueden pasar de la existencia
router.put('/:itemId', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const itemId = enteroPositivo(req.params.itemId);
  const cantidad = enteroPositivo(req.body.cantidad);
  if (!cantidad) return res.status(400).json({ success: false, message: 'La cantidad debe ser un número entero mayor que 0' });
  if (!itemId) return res.status(404).json({ success: false, message: 'Item no encontrado' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const item = await client.query(
      'SELECT id, producto_id FROM core.tblcarrito_items WHERE id = $1 AND usuario_id = $2',
      [itemId, userId]
    );
    if (item.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Item no encontrado' });
    }
    const productoId = item.rows[0].producto_id;
    const producto = await client.query('SELECT nombre, stock_online FROM core.tblproductos WHERE id = $1 FOR UPDATE', [productoId]);
    const { nombre, stock_online: existencia } = producto.rows[0];
    const otros = await client.query(
      'SELECT COALESCE(SUM(cantidad), 0)::int AS otros FROM core.tblcarrito_items WHERE usuario_id = $1 AND producto_id = $2 AND id <> $3',
      [userId, productoId, itemId]
    );
    if (otros.rows[0].otros + cantidad > existencia) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: existencia === 0 ? `"${nombre}" está agotado` : `Solo quedan ${existencia} unidades` });
    }

    const actualizado = await client.query(
      'UPDATE core.tblcarrito_items SET cantidad = $1, updated_at = NOW() WHERE id = $2 AND usuario_id = $3 RETURNING id',
      [cantidad, itemId, userId]
    );
    if (actualizado.rows.length === 0) {
      // Lo quitaron en otra pestaña mientras se esperaba el bloqueo
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Item no encontrado' });
    }
    const count = await contarCarrito(client, userId);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Cantidad actualizada', count });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (esTopeRenglon(error)) return res.status(400).json({ success: false, message: MSG_TOPE_RENGLON });
    console.error('Error PUT /carrito/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar' });
  } finally {
    if (client) client.release();
  }
});

// Eliminar item
router.delete('/:itemId', verifyToken, async (req, res) => {
  try {
    const itemId = enteroPositivo(req.params.itemId);
    if (!itemId) return res.status(404).json({ success: false, message: 'Item no encontrado' });
    const result = await pool.query('DELETE FROM core.tblcarrito_items WHERE id = $1 AND usuario_id = $2 RETURNING id', [itemId, req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Item no encontrado' });
    const count = await contarCarrito(pool, req.user.userId);
    res.json({ success: true, message: 'Item eliminado', count });
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
