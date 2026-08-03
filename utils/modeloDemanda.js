// utils/modeloDemanda.js — Carga y evaluación del modelo de demanda
//
// El modelo es una regresión lineal entrenada en la libreta
// 06_Notebooks/Solucion3_Prediccion_Demanda.ipynb. Como el backend es
// Node y no puede leer un .joblib de Python, la libreta exporta sus
// coeficientes a modelos/prediccion_demanda.json y aquí se evalúan:
//
//     unidades = intercepto + Σ (coeficiente_i × variable_i)
//
// Las variables categóricas (temporada, prox_festivo, producto_id) entran
// como one-hot: aporta el coeficiente de la categoría activa y cero para
// las demás. Una categoría que el modelo no vio al entrenar aporta
// `valor_si_falta_categoria`.
//
// Este archivo NO contiene ningún número del modelo: todos vienen del
// JSON. Si el archivo falta o está corrupto, `hayModelo()` devuelve false
// y quien llama debe usar su propio respaldo.

const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'modelos', 'prediccion_demanda.json');

const VARIABLES_NUMERICAS = [
  'dia_sem', 'mes', 'festivo', 'dias_festivo', 'dias_desde',
  'pegado_finde', 'tendencia',
];
const VARIABLES_CATEGORICAS = ['temporada', 'prox_festivo', 'producto_id'];

let contrato = null;
let errorCarga = null;

function cargar() {
  if (contrato || errorCarga) return contrato;
  try {
    const crudo = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    if (typeof crudo.intercepto !== 'number' || !crudo.coeficientes) {
      throw new Error('el contrato no trae intercepto o coeficientes');
    }
    crudo.productosConocidos = new Set(
      (crudo.categorias?.producto_id || []).map(Number)
    );
    contrato = crudo;
    console.log(
      `[modeloDemanda] ${crudo.modelo} cargado · ` +
      `${Object.keys(crudo.coeficientes).length} coeficientes · ` +
      `entrenado con datos de ${crudo.rango_entrenamiento?.desde} a ${crudo.rango_entrenamiento?.hasta}`
    );
  } catch (e) {
    errorCarga = e.message;
    console.warn(`[modeloDemanda] sin modelo entrenado (${e.message}); se usará el respaldo histórico`);
  }
  return contrato;
}

/** ¿Hay modelo entrenado disponible? */
function hayModelo() {
  return cargar() !== null;
}

/** ¿El modelo vio este producto durante el entrenamiento? */
function conoceProducto(productoId) {
  const c = cargar();
  return c ? c.productosConocidos.has(Number(productoId)) : false;
}

/** Días transcurridos desde el origen que fijó la libreta. */
function tendenciaDe(fechaIso) {
  const c = cargar();
  if (!c?.origen_tendencia) return 0;
  const MS_DIA = 86400000;
  return Math.round(
    (Date.parse(`${fechaIso}T00:00:00Z`) - Date.parse(`${c.origen_tendencia}T00:00:00Z`)) / MS_DIA
  );
}

/**
 * Evalúa el modelo para un vector de variables.
 * @param {object} vars dia_sem, mes, festivo, dias_festivo, dias_desde,
 *   pegado_finde, tendencia, temporada, prox_festivo, producto_id
 * @param {boolean} redondear aplicar redondeo y truncado (falso al validar
 *   contra los casos de prueba, que traen el valor continuo de sklearn)
 * @returns {number|null} unidades estimadas, o null si no hay modelo
 */
function predecir(vars, redondear = true) {
  const c = cargar();
  if (!c) return null;

  let z = c.intercepto;

  for (const nombre of VARIABLES_NUMERICAS) {
    const coef = c.coeficientes[nombre];
    if (coef === undefined) continue;
    z += coef * (Number(vars[nombre]) || 0);
  }

  for (const nombre of VARIABLES_CATEGORICAS) {
    const valor = vars[nombre];
    if (valor === null || valor === undefined) continue;
    const coef = c.coeficientes[`${nombre}=${valor}`];
    z += coef !== undefined ? coef : (c.valor_si_falta_categoria || 0);
  }

  if (!redondear) return z;
  if (c.truncar_negativos_a_cero && z < 0) return 0;
  return Math.max(0, Math.round(z));
}

/** Metadatos del modelo, para exponerlos en la ficha técnica de la vista. */
function infoModelo() {
  const c = cargar();
  if (!c) return null;
  return {
    modelo: c.modelo,
    libreta: c.libreta,
    coeficientes: Object.keys(c.coeficientes).length,
    rango_entrenamiento: c.rango_entrenamiento,
    metricas: c.metricas,
  };
}

/**
 * Comprueba la implementación contra los casos que exportó la libreta.
 * @returns {{ ok: boolean, peor: number, casos: Array }}
 */
function validarContraCasosPrueba(tolerancia = 1e-6) {
  const c = cargar();
  if (!c?.casos_prueba?.length) return { ok: false, peor: NaN, casos: [] };

  let peor = 0;
  const casos = c.casos_prueba.map(caso => {
    const propia = predecir(caso.variables, false);
    const diferencia = Math.abs(propia - caso.prediccion);
    if (diferencia > peor) peor = diferencia;
    return {
      descripcion: caso.descripcion,
      sklearn: caso.prediccion,
      backend: propia,
      diferencia,
      ok: diferencia < tolerancia,
    };
  });
  return { ok: casos.every(x => x.ok), peor, casos };
}

module.exports = {
  hayModelo,
  conoceProducto,
  tendenciaDe,
  predecir,
  infoModelo,
  validarContraCasosPrueba,
  RUTA,
};
