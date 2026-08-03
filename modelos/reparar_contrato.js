// modelos/reparar_contrato.js
//
// Normaliza el contrato que exporta la libreta antes de que el backend lo
// use. Corrige dos cosas que impedirían que los nombres del modelo casen
// con los que produce el sistema:
//
//   1) Doble codificación en los nombres de festividad. La libreta los
//      escribió en UTF-8 pero el archivo se guardó como latin-1, así que
//      "Año Nuevo" llegó como "AÃ±o Nuevo". Se revierte leyendo los bytes
//      como latin-1 y decodificándolos como UTF-8.
//   2) La temporada "otonio" (transliteración del ETL) se renombra a
//      "otoño", que es lo que genera variablesCalendario().
//
// El original se conserva sin tocar en prediccion_demanda_contrato_original.json
// para que la corrección sea auditable.
//
// Uso:  node modelos/reparar_contrato.js
const fs = require('fs');
const path = require('path');

const ORIGEN = path.join(__dirname, 'prediccion_demanda_contrato_original.json');
const DESTINO = path.join(__dirname, 'prediccion_demanda.json');

/** Revierte UTF-8 leído como latin-1 ("AÃ±o" → "Año"). */
function repararTexto(s) {
  if (typeof s !== 'string' || !/[ÃÂ]/.test(s)) return s;
  const reparado = Buffer.from(s, 'latin1').toString('utf8');
  // Solo se acepta si desaparecieron los caracteres sospechosos y no
  // aparecieron reemplazos inválidos
  return !/[ÃÂ]/.test(reparado) && !reparado.includes('�') ? reparado : s;
}

const ALIAS_TEMPORADA = { otonio: 'otoño' };

function normalizarClave(clave) {
  const sep = clave.indexOf('=');
  if (sep === -1) return clave;
  const variable = clave.slice(0, sep);
  let valor = repararTexto(clave.slice(sep + 1));
  if (variable === 'temporada') valor = ALIAS_TEMPORADA[valor] || valor;
  return `${variable}=${valor}`;
}

const contrato = JSON.parse(fs.readFileSync(ORIGEN, 'utf8'));
const cambios = [];

const coeficientes = {};
for (const [clave, valor] of Object.entries(contrato.coeficientes)) {
  const nueva = normalizarClave(clave);
  if (nueva !== clave) cambios.push(`${clave}  →  ${nueva}`);
  coeficientes[nueva] = valor;
}
contrato.coeficientes = coeficientes;

contrato.categorias.temporada = contrato.categorias.temporada
  .map(t => ALIAS_TEMPORADA[t] || t);
contrato.categorias.prox_festivo = contrato.categorias.prox_festivo
  .map(repararTexto);

for (const caso of contrato.casos_prueba || []) {
  if (caso.variables.prox_festivo) {
    caso.variables.prox_festivo = repararTexto(caso.variables.prox_festivo);
  }
  if (caso.variables.temporada) {
    caso.variables.temporada = ALIAS_TEMPORADA[caso.variables.temporada] || caso.variables.temporada;
  }
  caso.variables.producto_id = Number(caso.variables.producto_id);
}

contrato.normalizacion = {
  aplicada_por: 'modelos/reparar_contrato.js',
  origen: 'prediccion_demanda_contrato_original.json',
  correcciones: [
    'doble codificación latin-1/UTF-8 en nombres de festividad',
    'temporada "otonio" renombrada a "otoño"',
    'producto_id de los casos de prueba convertido a número',
  ],
};

fs.writeFileSync(DESTINO, JSON.stringify(contrato, null, 2), 'utf8');

console.log(`Contrato normalizado → ${path.basename(DESTINO)}`);
console.log(`Claves corregidas: ${cambios.length}`);
for (const c of cambios) console.log(`  ${c}`);
console.log(`\nTemporadas: ${contrato.categorias.temporada.join(', ')}`);
console.log(`Festividades: ${contrato.categorias.prox_festivo.join(' · ')}`);
