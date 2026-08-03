// utils/prediccionDemanda.js — Predicción de demanda POR PRODUCTO y día
//
// Regresión sobre variables de calendario. El dataset se construye EN
// VIVO desde la base (nada quemado): para cada fecha y producto se
// derivan las variables que el negocio reconoce —día de la semana,
// festividad próxima y pasada, temporada— y se estima cuántas unidades
// se venderán.
//
// Coeficientes iniciales; se reemplazan por el modelo de regresión
// entrenado (Lineal / Random Forest) conforme se acumule histórico — la
// interfaz no cambia.
//
// Nota de datos: la variable "mismo día del año anterior" ya está
// implementada, pero hoy el histórico del sistema arranca en noviembre
// de 2025, así que todavía no hay un año completo con el cual comparar;
// mientras tanto la base de la estimación es el promedio del producto
// para ese día de la semana.

const { pool } = require('../config/database');

const MS_DIA = 86400000;
const TOPE_DIAS = 30; // más allá de 30 días, la festividad ya no influye

/** Fecha (YYYY-MM-DD) en hora local del negocio: México, UTC-6 sin DST */
function aFechaLocal(valor) {
  const d = new Date(valor);
  const local = new Date(d.getTime() - 6 * 3600000);
  return local.toISOString().slice(0, 10);
}

function fechaISO(fecha) {
  return fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha).slice(0, 10);
}

/** 0 = lunes … 6 = domingo (convención del modelo) */
function diaSemanaLunes(fechaIso) {
  const dow = new Date(`${fechaIso}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return (dow + 6) % 7;
}

function temporadaDe(fechaIso) {
  const mes = Number(fechaIso.slice(5, 7));
  if (mes >= 3 && mes <= 5) return 'primavera';
  if (mes >= 6 && mes <= 8) return 'verano';
  if (mes >= 9 && mes <= 11) return 'otoño';
  return 'invierno';
}

function diferenciaDias(desdeIso, hastaIso) {
  return Math.round((Date.parse(`${hastaIso}T00:00:00Z`) - Date.parse(`${desdeIso}T00:00:00Z`)) / MS_DIA);
}

/**
 * Variables de calendario de una fecha, a partir de las festividades
 * registradas por la dueña en core.tblfechas_especiales.
 */
function variablesCalendario(fechaIso, festivos) {
  const propio = festivos.find(f => f.fecha === fechaIso) || null;

  let proximo = null;
  let diasFestivo = TOPE_DIAS;
  let pasado = null;
  let diasDesde = TOPE_DIAS;

  for (const f of festivos) {
    const delta = diferenciaDias(fechaIso, f.fecha);
    if (delta > 0 && delta < diasFestivo) { diasFestivo = delta; proximo = f; }
    if (delta < 0 && -delta < diasDesde) { diasDesde = -delta; pasado = f; }
  }
  if (propio) { diasFestivo = 0; proximo = propio; }

  // ¿La festividad próxima cae en fin de semana? (viernes, sábado o domingo)
  const refFinde = proximo ? proximo.fecha : null;
  const dowProx = refFinde ? diaSemanaLunes(refFinde) : null;
  const pegadoFinde = dowProx !== null && dowProx >= 4 ? 1 : 0;

  return {
    dia_sem: diaSemanaLunes(fechaIso),
    festivo: propio ? 1 : 0,
    nombre_festivo: propio ? propio.nombre : null,
    color_festivo: propio ? propio.color : null,
    prox_festivo: proximo ? proximo.nombre : null,
    dias_festivo: Math.min(diasFestivo, TOPE_DIAS),
    festivo_pasado: pasado ? pasado.nombre : null,
    dias_desde: Math.min(diasDesde, TOPE_DIAS),
    pegado_finde: pegadoFinde,
    temporada: temporadaDe(fechaIso),
  };
}

// ── Coeficientes iniciales del modelo ────────────────────────────────
// Multiplicadores sobre la base histórica del producto.
const MULT_ANTICIPACION = [
  { hasta: 0, factor: 2.10 },  // el día de la festividad
  { hasta: 1, factor: 1.95 },  // víspera: el pico real de una repostería
  { hasta: 2, factor: 1.70 },
  { hasta: 3, factor: 1.45 },
  { hasta: 5, factor: 1.22 },
  { hasta: 7, factor: 1.10 },
  { hasta: 14, factor: 1.03 },
];
// Cola de rezagados: después de la festividad la venta sigue elevada y
// va cediendo (quien no alcanzó a comprar, compra los días siguientes)
const MULT_COLA = [
  { hasta: 1, factor: 1.15 },
  { hasta: 2, factor: 1.08 },
  { hasta: 3, factor: 1.03 },
];
const MULT_TEMPORADA = { primavera: 1.05, verano: 0.95, otoño: 1.02, invierno: 1.08 };
const MULT_FINDE_FESTIVO = 1.08; // festividad pegada al fin de semana: se celebra más

function multiplicadorPorRangos(dias, tabla) {
  for (const r of tabla) if (dias <= r.hasta) return r.factor;
  return 1;
}

/**
 * Predice unidades de un producto en una fecha.
 * @param {object} base { promedio_dow, promedio_general, hist_anio_ant }
 * @param {object} vars variables de calendario de la fecha
 */
function predecirUnidades(base, vars) {
  // Punto de partida: el mismo día del año anterior si existe; si no, el
  // promedio del producto para ese día de la semana; si tampoco, su promedio.
  const partida = base.hist_anio_ant !== null && base.hist_anio_ant !== undefined
    ? base.hist_anio_ant
    : (base.promedio_dow || base.promedio_general || 0);

  let estimado = partida;
  estimado *= multiplicadorPorRangos(vars.dias_festivo, MULT_ANTICIPACION);
  estimado *= multiplicadorPorRangos(vars.dias_desde, MULT_COLA);
  estimado *= MULT_TEMPORADA[vars.temporada] || 1;
  if (vars.pegado_finde && vars.dias_festivo <= 3) estimado *= MULT_FINDE_FESTIVO;

  return Math.max(0, Math.round(estimado));
}

/**
 * Dataset base por producto: promedio por día de la semana y promedio
 * general, calculados de las ventas reales (pedidos no cancelados).
 */
async function basePorProducto() {
  const { rows } = await pool.query(`
    WITH ventas_dia AS (
      SELECT i.producto_id,
             DATE(p.created_at AT TIME ZONE 'UTC' - INTERVAL '6 hours') AS dia,
             SUM(i.cantidad)::numeric AS unidades
      FROM core.tblpedido_items i
      JOIN core.tblpedidos p ON p.id = i.pedido_id
      WHERE p.estado IN ('completado', 'entregado') AND i.producto_id IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT v.producto_id,
           EXTRACT(ISODOW FROM v.dia)::int - 1 AS dia_sem,
           AVG(v.unidades)::float AS promedio,
           SUM(v.unidades)::float AS total
    FROM ventas_dia v
    GROUP BY 1, 2
  `);

  const porProducto = new Map();
  for (const r of rows) {
    if (!porProducto.has(r.producto_id)) porProducto.set(r.producto_id, { dow: new Map(), suma: 0, n: 0 });
    const p = porProducto.get(r.producto_id);
    p.dow.set(r.dia_sem, r.promedio);
    p.suma += r.promedio;
    p.n += 1;
  }
  return porProducto;
}

/** Unidades reales del mismo día del año anterior, por producto */
async function historicoAnioAnterior(fechaIso) {
  const { rows } = await pool.query(`
    SELECT i.producto_id, SUM(i.cantidad)::float AS unidades
    FROM core.tblpedido_items i
    JOIN core.tblpedidos p ON p.id = i.pedido_id
    WHERE p.estado IN ('completado', 'entregado')
      AND DATE(p.created_at AT TIME ZONE 'UTC' - INTERVAL '6 hours') = ($1::date - INTERVAL '1 year')::date
    GROUP BY 1
  `, [fechaIso]);
  return new Map(rows.map(r => [r.producto_id, r.unidades]));
}

async function cargarFestivos() {
  const { rows } = await pool.query(
    `SELECT fecha, nombre, color, dias_anticipacion FROM core.tblfechas_especiales ORDER BY fecha`
  );
  return rows.map(r => ({ ...r, fecha: fechaISO(r.fecha) }));
}

module.exports = {
  aFechaLocal,
  fechaISO,
  diaSemanaLunes,
  temporadaDe,
  variablesCalendario,
  predecirUnidades,
  basePorProducto,
  historicoAnioAnterior,
  cargarFestivos,
  TOPE_DIAS,
};
