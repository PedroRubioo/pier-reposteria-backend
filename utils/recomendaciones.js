// utils/recomendaciones.js — Afinidad entre productos
//
// Filtrado colaborativo ítem-ítem calculado sobre los datos reales:
// matriz cliente × producto (cantidades compradas) construida desde los
// pedidos completados de usuarios con rol cliente. La afinidad entre dos
// productos es la similitud coseno de sus vectores de compra, ponderada
// por cantidad, con desempate por número de co-compradores. La matriz de
// similitud se precalcula bajo demanda y se cachea en memoria (con ~92
// productos y ~15k pedidos el cálculo es ligero). La usan las
// recomendaciones del detalle de producto y las sugerencias del feed.
const { pool } = require('../config/database');

const TTL_CACHE_MS = 10 * 60 * 1000;
let cache = { calculadoEn: 0, similares: null };

async function obtenerSimilares() {
  if (cache.similares && Date.now() - cache.calculadoEn < TTL_CACHE_MS) return cache.similares;

  // Ventas consumadas: recoger en sucursal ('completado') y entrega a
  // domicilio ('entregado') cuentan igual como compra del cliente
  const result = await pool.query(`
    SELECT p.usuario_id, i.producto_id, SUM(i.cantidad)::float AS unidades
    FROM core.tblpedidos p
    JOIN core.tblpedido_items i ON i.pedido_id = p.id
    JOIN core.tblusuarios u ON u.id = p.usuario_id
    WHERE p.estado IN ('completado', 'entregado') AND u.rol = 'cliente' AND i.producto_id IS NOT NULL
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

module.exports = { obtenerSimilares };
