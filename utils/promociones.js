// utils/promociones.js — La promoción que se cobra (Diseno_Panel_Cliente.md §5.3)
//
// Una regla para carrito, cobro y feed: por producto, la promoción activa y
// vigente (ya empezó y no ha terminado) con mayor descuento; si empatan, la
// más reciente. El LATERAL con LIMIT 1 da a lo más un renglón por producto,
// así que dos promociones activas ya no duplican el renglón ni el cobro.
// Requiere el producto con el alias `p`; expone `pr`.
const JOIN_PROMO_VIGENTE = `LEFT JOIN LATERAL (
    SELECT x.descuento_porcentaje, x.precio_oferta, x.tipo, x.nombre_temporada
      FROM core.tblpromociones x
     WHERE x.producto_id = p.id AND x.estado = 'activa'
       AND (x.fecha_inicio IS NULL OR x.fecha_inicio <= NOW())
       AND (x.fecha_fin IS NULL OR x.fecha_fin > NOW())
     ORDER BY x.descuento_porcentaje DESC NULLS LAST, x.created_at DESC, x.id DESC
     LIMIT 1) pr ON TRUE`;

/** Precio del tamaño con el descuento (porcentaje, redondeado a pesos como siempre) */
const precioConPromocion = (precioBase, descuento) =>
  descuento ? Math.round(precioBase * (1 - parseFloat(descuento) / 100)) : precioBase;

module.exports = { JOIN_PROMO_VIGENTE, precioConPromocion };
