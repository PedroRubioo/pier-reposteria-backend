// routes/recomendacionesRoutes.js — Recomendaciones de productos
//
// Filtrado colaborativo ítem-ítem calculado sobre los datos reales:
// matriz cliente × producto (cantidades compradas) construida desde los
// pedidos completados de usuarios con rol cliente. La afinidad entre dos
// productos es la similitud coseno de sus vectores de compra, ponderada
// por cantidad, con desempate por número de co-compradores. La matriz de
// similitud se precalcula bajo demanda y se cachea en memoria (con ~92
// productos y ~15k pedidos el cálculo es ligero).
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

const TTL_CACHE_MS = 10 * 60 * 1000;
let cache = { calculadoEn: 0, similares: null };

async function obtenerSimilares() {
  if (cache.similares && Date.now() - cache.calculadoEn < TTL_CACHE_MS) return cache.similares;

  const result = await pool.query(`
    SELECT p.usuario_id, i.producto_id, SUM(i.cantidad)::float AS unidades
    FROM core.tblpedidos p
    JOIN core.tblpedido_items i ON i.pedido_id = p.id
    JOIN core.tblusuarios u ON u.id = p.usuario_id
    WHERE p.estado = 'completado' AND u.rol = 'cliente' AND i.producto_id IS NOT NULL
    GROUP BY p.usuario_id, i.producto_id
  `);

  // Vector de compras por producto: producto → (cliente → unidades)
  const porProducto = new Map();
  for (const fila of result.rows) {
    if (!porProducto.has(fila.producto_id)) porProducto.set(fila.producto_id, new Map());
    porProducto.get(fila.producto_id).set(fila.usuario_id, fila.unidades);
  }

  const normas = new Map();
  for (const [productoId, vector] of porProducto) {
    let suma = 0;
    for (const v of vector.values()) suma += v * v;
    normas.set(productoId, Math.sqrt(suma));
  }

  const similares = new Map();
  const ids = [...porProducto.keys()];
  for (const a of ids) {
    const vectorA = porProducto.get(a);
    const lista = [];
    for (const b of ids) {
      if (b === a) continue;
      const vectorB = porProducto.get(b);
      const [chico, grande] = vectorA.size <= vectorB.size ? [vectorA, vectorB] : [vectorB, vectorA];
      let punto = 0;
      let coCompradores = 0;
      for (const [cliente, valor] of chico) {
        const otro = grande.get(cliente);
        if (otro !== undefined) { punto += valor * otro; coCompradores++; }
      }
      if (coCompradores === 0) continue;
      lista.push({ id: b, score: punto / (normas.get(a) * normas.get(b)), coCompradores });
    }
    lista.sort((x, y) => (y.score - x.score) || (y.coCompradores - x.coCompradores));
    similares.set(a, lista);
  }

  cache = { calculadoEn: Date.now(), similares };
  return similares;
}

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
        LEFT JOIN core.tblpedidos pe ON pe.id = i.pedido_id AND pe.estado = 'completado'
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
