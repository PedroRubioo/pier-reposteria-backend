// utils/ventasReportes.js — Cifras de ventas del Resumen y de Reportes
// (Diseno_Panel_Direccion.md §4.1 y §4.2). Una sola definición para ambos:
//   · pedido en línea válido: no cancelado y con el pago cobrado. Aprobar
//     un reembolso cambia el pago a 'reembolsado', pero el cobro sí ocurrió:
//     el pedido sigue contando y el reembolso se resta aparte (si no, se
//     restaría dos veces);
//   · se restan los reembolsos aprobados o procesados en el periodo (por su
//     fecha de resolución) de pedidos válidos. El de un pedido cancelado no
//     se resta: ese pedido ya no suma;
//   · se suman las comandas entregadas en el periodo (canal sucursal).
// Pedidos, ticket promedio y clientes cuentan solo los pedidos en línea.
// Todos los días son de Huejutla.
const { pool } = require('../config/database');
const { ZONA_HUEJUTLA, dos, diaHuejutla, sumarDias, diasEntre, restarMeses } = require('./fechasHuejutla');

const PERIODOS = ['semana', 'mes', 'trimestre', 'anio'];

const CANALES = [
  { canal: 'recoger', etiqueta: 'En línea para recoger' },
  { canal: 'domicilio', etiqueta: 'En línea a domicilio' },
  { canal: 'sucursal', etiqueta: 'Sucursal (comandas)' },
];

// Lo que el Resumen pone en "Para atender", en este orden
const PENDIENTES = [
  { clave: 'pedidos_por_confirmar', etiqueta: 'Pedidos por confirmar', enlace: '/direccion/pedidos' },
  { clave: 'pedidos_listos', etiqueta: 'Pedidos listos sin entregar', enlace: '/direccion/pedidos' },
  { clave: 'comandas_hoy', etiqueta: 'Comandas para hoy', enlace: '/direccion/comandas' },
  { clave: 'comandas_manana', etiqueta: 'Comandas para mañana', enlace: '/direccion/comandas' },
  { clave: 'reembolsos', etiqueta: 'Reembolsos por resolver', enlace: '/direccion/atencion?tab=reembolsos' },
  { clave: 'quejas', etiqueta: 'Quejas abiertas', enlace: '/direccion/atencion?tab=quejas' },
  { clave: 'productos_agotados', etiqueta: 'Productos agotados', enlace: '/direccion/productos' },
  { clave: 'mensajes', etiqueta: 'Mensajes de contacto sin leer', enlace: '/direccion/atencion?tab=mensajes' },
];

/** Monto como número con 2 decimales (los NUMERIC llegan como texto) */
const dinero = (valor) => Math.round((Number(valor) || 0) * 100) / 100;

// ── SQL ──
// Tramo de días completos de Huejutla: $1 desde y $2 hasta, ambos incluidos
const LIMITES = `lim AS (
  SELECT ($1::date)::timestamp AT TIME ZONE '${ZONA_HUEJUTLA}' AS ini,
         ($2::date + 1)::timestamp AT TIME ZONE '${ZONA_HUEJUTLA}' AS fin)`;

const VALIDOS = `validos AS (
  SELECT p.id, p.usuario_id, p.total, p.created_at,
         CASE WHEN p.tipo_entrega = 'domicilio' THEN 'domicilio' ELSE 'recoger' END AS canal
    FROM core.tblpedidos p
   WHERE p.estado <> 'cancelado'
     AND EXISTS (SELECT 1 FROM core.tblpagos pg
                  WHERE pg.pedido_id = p.id AND pg.estado IN ('pagado', 'reembolsado')))`;

const DIA = (columna) => `to_char(${columna} AT TIME ZONE '${ZONA_HUEJUTLA}', 'YYYY-MM-DD')`;
const EN_TRAMO = (columna) => `${columna} >= lim.ini AND ${columna} < lim.fin`;

// Movimientos del tramo por día y canal, más los clientes distintos
const SQL_MOVIMIENTOS = `
  WITH ${LIMITES}, ${VALIDOS}
  SELECT 'pedido' AS tipo, ${DIA('v.created_at')} AS fecha, v.canal, SUM(v.total) AS importe, COUNT(*)::int AS cantidad
    FROM validos v JOIN lim ON ${EN_TRAMO('v.created_at')}
   GROUP BY 2, 3
  UNION ALL
  SELECT 'reembolso', ${DIA('r.fecha_resolucion')}, v.canal, SUM(r.monto), COUNT(*)::int
    FROM core.tblreembolsos r
    JOIN validos v ON v.id = r.pedido_id
    JOIN lim ON ${EN_TRAMO('r.fecha_resolucion')}
   WHERE r.estado IN ('aprobado', 'procesado')
   GROUP BY 2, 3
  UNION ALL
  SELECT 'comanda', ${DIA('c.entregada_at')}, 'sucursal', SUM(c.total), COUNT(*)::int
    FROM core.tblcomandas c JOIN lim ON ${EN_TRAMO('c.entregada_at')}
   WHERE c.estado = 'entregada'
   GROUP BY 2
  UNION ALL
  SELECT 'clientes', NULL, NULL, NULL, COUNT(DISTINCT v.usuario_id)::int
    FROM validos v JOIN lim ON ${EN_TRAMO('v.created_at')}`;

// Líneas vendidas por producto: pedidos en línea válidos y comandas
// entregadas. Importe de cada línea (sin envío, sin el descuento de la
// comanda y sin reembolsos). Los pasteles personalizados no son del catálogo
const SQL_LINEAS = `
  WITH ${LIMITES}, ${VALIDOS},
  lineas AS (
    SELECT i.producto_id, i.nombre_producto AS nombre, FALSE AS personalizado, i.cantidad, i.subtotal
      FROM core.tblpedido_items i
      JOIN validos v ON v.id = i.pedido_id
      JOIN lim ON ${EN_TRAMO('v.created_at')}
    UNION ALL
    SELECT ci.producto_id, ci.nombre, ci.tipo = 'pastel', ci.cantidad, ci.subtotal
      FROM core.tblcomanda_items ci
      JOIN core.tblcomandas c ON c.id = ci.comanda_id
      JOIN lim ON ${EN_TRAMO('c.entregada_at')}
     WHERE c.estado = 'entregada')
  SELECT l.producto_id, COALESCE(pr.nombre, l.nombre) AS nombre,
         CASE WHEN l.personalizado THEN 'Pasteles personalizados' ELSE COALESCE(cat.nombre, 'Sin categoría') END AS categoria,
         SUM(l.cantidad)::int AS unidades, SUM(l.subtotal) AS ventas
    FROM lineas l
    LEFT JOIN core.tblproductos pr ON pr.id = l.producto_id
    LEFT JOIN core.tblcategorias cat ON cat.id = pr.categoria_id
   GROUP BY 1, 2, 3
   ORDER BY ventas DESC, unidades DESC, nombre`;

// Mejores clientes del tramo: sus pedidos válidos menos sus reembolsos
const SQL_CLIENTES_TOP = `
  WITH ${LIMITES}, ${VALIDOS},
  compras AS (
    SELECT v.usuario_id, COUNT(*)::int AS pedidos, SUM(v.total) AS bruto, MAX(v.created_at) AS ultima
      FROM validos v JOIN lim ON ${EN_TRAMO('v.created_at')}
     GROUP BY v.usuario_id),
  devoluciones AS (
    SELECT v.usuario_id, SUM(r.monto) AS monto
      FROM core.tblreembolsos r
      JOIN validos v ON v.id = r.pedido_id
      JOIN lim ON ${EN_TRAMO('r.fecha_resolucion')}
     WHERE r.estado IN ('aprobado', 'procesado')
     GROUP BY v.usuario_id)
  SELECT c.usuario_id, TRIM(u.nombre || ' ' || u.apellido) AS nombre, c.pedidos,
         c.bruto - COALESCE(d.monto, 0) AS ventas, ${DIA('c.ultima')} AS ultima_compra
    FROM compras c
    JOIN core.tblusuarios u ON u.id = c.usuario_id
    LEFT JOIN devoluciones d ON d.usuario_id = c.usuario_id
   ORDER BY ventas DESC, c.pedidos DESC, c.usuario_id
   LIMIT 20`;

// $1 = hoy en Huejutla
const SQL_PENDIENTES = `
  SELECT
    (SELECT COUNT(*)::int FROM core.tblpedidos WHERE por_confirmar = TRUE AND estado <> 'cancelado') AS pedidos_por_confirmar,
    (SELECT COUNT(*)::int FROM core.tblpedidos WHERE estado = 'listo') AS pedidos_listos,
    (SELECT COUNT(*)::int FROM core.tblcomandas WHERE estado = 'activa' AND fecha_entrega = $1::date) AS comandas_hoy,
    (SELECT COUNT(*)::int FROM core.tblcomandas WHERE estado = 'activa' AND fecha_entrega = $1::date + 1) AS comandas_manana,
    (SELECT COUNT(*)::int FROM core.tblreembolsos WHERE estado IN ('pendiente', 'en_revision')) AS reembolsos,
    (SELECT COUNT(*)::int FROM core.tblquejas WHERE estado IN ('pendiente', 'en_proceso')) AS quejas,
    (SELECT COUNT(*)::int FROM core.tblproductos pr JOIN core.tblcategorias ca ON ca.id = pr.categoria_id
      WHERE pr.activo = TRUE AND ca.activo = TRUE AND pr.stock_online = 0) AS productos_agotados,
    (SELECT COUNT(*)::int FROM core.tblcontacto_mensajes WHERE leido = FALSE) AS mensajes`;

// ── Cálculo ──

/** Ventas de un tramo por día y por canal, con sus totales */
async function cifrasDelTramo(desde, hasta) {
  const { rows } = await pool.query(SQL_MOVIMIENTOS, [desde, hasta]);
  const dias = new Map();
  const canales = new Map(CANALES.map(c => [c.canal, { ventas: 0, pedidos: 0 }]));
  let enLinea = 0, pedidos = 0, reembolsos = 0, sucursal = 0, comandas = 0, clientes = 0;
  for (const fila of rows) {
    if (fila.tipo === 'clientes') { clientes = fila.cantidad; continue; }
    const importe = Number(fila.importe);
    const neto = fila.tipo === 'reembolso' ? -importe : importe;
    const dia = dias.get(fila.fecha) || { ventas: 0, pedidos: 0 };
    const canal = canales.get(fila.canal);
    dia.ventas += neto;
    canal.ventas += neto;
    if (fila.tipo === 'pedido') {
      dia.pedidos += fila.cantidad;
      canal.pedidos += fila.cantidad;
      enLinea += importe;
      pedidos += fila.cantidad;
    } else if (fila.tipo === 'reembolso') {
      reembolsos += importe;
    } else {
      canal.pedidos += fila.cantidad;
      sucursal += importe;
      comandas += fila.cantidad;
    }
    dias.set(fila.fecha, dia);
  }
  return {
    dias,
    por_canal: CANALES.map(c => ({ ...c, ventas: dinero(canales.get(c.canal).ventas), pedidos: canales.get(c.canal).pedidos })),
    totales: {
      ventas: dinero(enLinea - reembolsos + sucursal),
      pedidos,
      ticket_promedio: pedidos > 0 ? dinero(enLinea / pedidos) : null,
      reembolsos: dinero(reembolsos),
      ventas_sucursal: dinero(sucursal),
      comandas_entregadas: comandas,
      clientes,
    },
  };
}

/**
 * Tramo del periodo hasta hoy y el mismo tramo del periodo anterior.
 * Semana (de lunes a hoy): contra los mismos días de la semana pasada, así
 * un lunes es un solo día contra el lunes anterior. Mes y trimestre: el
 * anterior abarca los mismos días transcurridos (del 1 al 18 contra del 1
 * al 18), sin pasar de su último día. Año: del 1 de enero a la misma fecha
 * del año pasado.
 */
function tramosDelPeriodo(periodo, hoy) {
  if (periodo === 'semana') {
    const lunes = sumarDias(hoy, -((new Date(hoy + 'T00:00:00Z').getUTCDay() + 6) % 7));
    return { desde: lunes, hasta: hoy, anterior: { desde: sumarDias(lunes, -7), hasta: sumarDias(hoy, -7) } };
  }
  const [anio, mes] = hoy.split('-').map(Number);
  if (periodo === 'anio') {
    return { desde: `${anio}-01-01`, hasta: hoy, anterior: { desde: `${anio - 1}-01-01`, hasta: restarMeses(hoy, 12) } };
  }
  const meses = periodo === 'trimestre' ? 3 : 1;
  const mesInicial = periodo === 'trimestre' ? Math.floor((mes - 1) / 3) * 3 + 1 : mes;
  const desde = `${anio}-${dos(mesInicial)}-01`;
  const desdeAnterior = restarMeses(desde, meses);
  const hastaAnterior = [sumarDias(desdeAnterior, diasEntre(desde, hoy) - 1), sumarDias(desde, -1)].sort()[0];
  return { desde, hasta: hoy, anterior: { desde: desdeAnterior, hasta: hastaAnterior } };
}

/** Por día; `anterior` es el día equivalente, o null si el periodo anterior es más corto */
function serieDiaria(actual, anterior, tramo) {
  const diasAnterior = diasEntre(tramo.anterior.desde, tramo.anterior.hasta);
  return Array.from({ length: diasEntre(tramo.desde, tramo.hasta) }, (_, i) => {
    const fecha = sumarDias(tramo.desde, i);
    const previo = i < diasAnterior ? anterior.dias.get(sumarDias(tramo.anterior.desde, i)) : null;
    return {
      fecha,
      ventas: dinero(actual.dias.get(fecha)?.ventas),
      anterior: i < diasAnterior ? dinero(previo?.ventas) : null,
    };
  });
}

/** Por mes, de enero al mes en curso, contra los mismos meses del año pasado */
function serieMensual(actual, anterior, tramo) {
  const [anio, mes] = tramo.hasta.split('-').map(Number);
  const delMes = (dias, prefijo) => {
    let suma = 0;
    for (const [fecha, dia] of dias) if (fecha.startsWith(prefijo)) suma += dia.ventas;
    return dinero(suma);
  };
  return Array.from({ length: mes }, (_, i) => ({
    fecha: `${anio}-${dos(i + 1)}-01`,
    ventas: delMes(actual.dias, `${anio}-${dos(i + 1)}-`),
    anterior: delMes(anterior.dias, `${anio - 1}-${dos(i + 1)}-`),
  }));
}

/** GET /api/reportes/resumen (§4.1) sin el success */
async function resumenDelPeriodo(periodo) {
  const hoy = diaHuejutla();
  const tramo = tramosDelPeriodo(periodo, hoy);
  const [actual, anterior, pendientesR] = await Promise.all([
    cifrasDelTramo(tramo.desde, tramo.hasta),
    cifrasDelTramo(tramo.anterior.desde, tramo.anterior.hasta),
    pool.query(SQL_PENDIENTES, [hoy]),
  ]);
  const a = actual.totales;
  const b = anterior.totales;
  const cantidades = new Map(Object.entries(pendientesR.rows[0]));
  return {
    periodo: tramo,
    cifras: {
      ventas: { valor: a.ventas, anterior: b.ventas },
      pedidos: { valor: a.pedidos, anterior: b.pedidos },
      ticket_promedio: { valor: a.ticket_promedio, anterior: b.ticket_promedio },
      clientes: { valor: a.clientes, anterior: b.clientes },
    },
    canales: actual.por_canal,
    serie: periodo === 'anio' ? serieMensual(actual, anterior, tramo) : serieDiaria(actual, anterior, tramo),
    pendientes: PENDIENTES
      .map(p => ({ ...p, cantidad: cantidades.get(p.clave) }))
      .filter(p => p.cantidad > 0),
  };
}

/** GET /api/reportes/ventas (§4.2) sin el success; desde y hasta ya validados */
async function reporteVentas(desde, hasta) {
  const [cifras, lineasR, clientesR] = await Promise.all([
    cifrasDelTramo(desde, hasta),
    pool.query(SQL_LINEAS, [desde, hasta]),
    pool.query(SQL_CLIENTES_TOP, [desde, hasta]),
  ]);
  const dias = diasEntre(desde, hasta);

  const categorias = new Map();
  for (const linea of lineasR.rows) {
    const cat = categorias.get(linea.categoria) || { categoria: linea.categoria, unidades: 0, ventas: 0 };
    cat.unidades += linea.unidades;
    cat.ventas += Number(linea.ventas);
    categorias.set(linea.categoria, cat);
  }

  return {
    rango: { desde, hasta, dias },
    totales: cifras.totales,
    por_dia: Array.from({ length: dias }, (_, i) => {
      const fecha = sumarDias(desde, i);
      const dia = cifras.dias.get(fecha);
      return { fecha, ventas: dinero(dia?.ventas), pedidos: dia ? dia.pedidos : 0 };
    }),
    por_producto: lineasR.rows.slice(0, 50).map(l => ({
      producto_id: l.producto_id, nombre: l.nombre, categoria: l.categoria, unidades: l.unidades, ventas: dinero(l.ventas),
    })),
    por_categoria: [...categorias.values()]
      .map(c => ({ ...c, ventas: dinero(c.ventas) }))
      .sort((x, y) => y.ventas - x.ventas || y.unidades - x.unidades),
    por_canal: cifras.por_canal,
    clientes_top: clientesR.rows.map(c => ({
      usuario_id: c.usuario_id, nombre: c.nombre, pedidos: c.pedidos, ventas: dinero(c.ventas), ultima_compra: c.ultima_compra,
    })),
  };
}

module.exports = { PERIODOS, dinero, resumenDelPeriodo, reporteVentas };
