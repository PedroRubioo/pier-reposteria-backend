// utils/prediccionDemanda.js — Predicción de demanda POR PRODUCTO y día
//
// De dónde sale cada número:
//
//   • La ESTIMACIÓN la produce el modelo de regresión lineal entrenado en
//     la libreta 06_Notebooks/Solucion3_Prediccion_Demanda.ipynb. Sus
//     coeficientes viven en modelos/prediccion_demanda.json y se evalúan
//     en utils/modeloDemanda.js. Este archivo no contiene ningún
//     coeficiente ni multiplicador: solo arma el vector de variables.
//
//   • Las VARIABLES DE CALENDARIO se derivan en vivo de la base: día de
//     la semana, mes, si la fecha es festiva, cuántos días faltan para la
//     próxima festividad y cuántos pasaron desde la anterior (ambos con
//     tope), si la festividad cae pegada al fin de semana, la temporada y
//     la tendencia. Las festividades salen de core.tblfechas_especiales,
//     que administra la dueña desde el panel de dirección.
//
//   • El RESPALDO, y solo cuando el modelo no está disponible (falta el
//     JSON) o cuando el producto no existía al entrenar, es el promedio
//     histórico de ese producto para ese día de la semana. Es un valor
//     calculado de las ventas reales, no una constante escrita a mano,
//     pero NO viene del modelo: por eso se marca con origen 'respaldo'
//     para que quede visible en la interfaz.
//
// Nota de datos: la variable "mismo día del año anterior" está calculada
// (historicoAnioAnterior) pero el modelo entrenado no la usa como
// predictora, porque el histórico del sistema arranca en noviembre de
// 2025 y todavía no hay un año completo con el cual comparar. Se conserva
// porque la vista la muestra como referencia.

const { pool } = require('../config/database');
const modelo = require('./modeloDemanda');

const MS_DIA = 86400000;
const TOPE_DIAS = 30; // más allá de 30 días, la festividad ya no influye

// Etiqueta que usó el ETL de la libreta cuando no hay festividad cercana;
// el modelo tiene un coeficiente entrenado para esta categoría.
const SIN_FESTIVO_CERCA = 'Ninguno cercano';

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
 * registradas por la dueña en core.tblfechas_especiales. Son exactamente
 * las columnas que el modelo espera recibir.
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
    mes: Number(fechaIso.slice(5, 7)),
    festivo: propio ? 1 : 0,
    nombre_festivo: propio ? propio.nombre : null,
    color_festivo: propio ? propio.color : null,
    prox_festivo: proximo ? proximo.nombre : null,
    dias_festivo: Math.min(diasFestivo, TOPE_DIAS),
    festivo_pasado: pasado ? pasado.nombre : null,
    dias_desde: Math.min(diasDesde, TOPE_DIAS),
    pegado_finde: pegadoFinde,
    temporada: temporadaDe(fechaIso),
    tendencia: modelo.tendenciaDe(fechaIso),
  };
}

/**
 * Predice unidades de un producto en una fecha.
 *
 * @param {object} base respaldo histórico { promedio_dow, promedio_general }
 * @param {object} vars variables de calendario de la fecha
 * @param {number} productoId producto a estimar
 * @returns {{ unidades: number, origen: 'modelo'|'respaldo', categorias_desconocidas?: string[] }}
 */
function predecirUnidades(base, vars, productoId) {
  if (modelo.hayModelo() && modelo.conoceProducto(productoId)) {
    const vector = {
      dia_sem: vars.dia_sem,
      mes: vars.mes,
      festivo: vars.festivo,
      dias_festivo: vars.dias_festivo,
      dias_desde: vars.dias_desde,
      pegado_finde: vars.pegado_finde,
      tendencia: vars.tendencia,
      temporada: vars.temporada,
      prox_festivo: vars.prox_festivo || SIN_FESTIVO_CERCA,
      producto_id: productoId,
    };
    const unidades = modelo.predecir(vector);
    if (unidades !== null) {
      // Categorías que el modelo no vio (p. ej. temporada 'verano'):
      // aportan cero, y se reportan para que quede rastro de que la
      // consulta salió del terreno con el que se entrenó.
      const desconocidas = modelo.categoriasDesconocidas(vector);
      return desconocidas.length > 0
        ? { unidades, origen: 'modelo', categorias_desconocidas: desconocidas }
        : { unidades, origen: 'modelo' };
    }
  }

  // Respaldo: promedio real del producto para ese día de la semana.
  const respaldo = base.promedio_dow || base.promedio_general || 0;
  return { unidades: Math.max(0, Math.round(respaldo)), origen: 'respaldo' };
}

/**
 * Dataset base por producto: promedio por día de la semana y promedio
 * general, calculados de las ventas reales (pedidos no cancelados).
 * Alimenta el respaldo y la comparación contra lo estimado.
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
  infoModelo: modelo.infoModelo,
  fueraDeRango: modelo.fueraDeRango,
  TOPE_DIAS,
};
