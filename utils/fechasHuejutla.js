// utils/fechasHuejutla.js — Días del calendario en hora de Huejutla
//
// Las fechas viajan como texto 'YYYY-MM-DD'. Para sumar días o meses se
// usan fechas UTC a medianoche: así ningún cambio de horario mueve el día.
const ZONA_HUEJUTLA = 'America/Mexico_City';

const DIA_HUEJUTLA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HUEJUTLA, year: 'numeric', month: '2-digit', day: '2-digit',
});
const HORA_HUEJUTLA = new Intl.DateTimeFormat('es-MX', {
  timeZone: ZONA_HUEJUTLA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const aFecha = (iso) => new Date(`${iso}T00:00:00Z`);
const aISO = (fecha) => fecha.toISOString().slice(0, 10);
const dos = (n) => String(n).padStart(2, '0');

/** Día de Huejutla de un instante (por defecto, ahora) */
const diaHuejutla = (instante = new Date()) => DIA_HUEJUTLA.format(instante);

/** Hora 'HH:MM' de Huejutla de un instante */
const horaHuejutla = (instante) => HORA_HUEJUTLA.format(instante);

function sumarDias(iso, dias) {
  const fecha = aFecha(iso);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return aISO(fecha);
}

/** Días de `desde` a `hasta`, ambos incluidos */
const diasEntre = (desde, hasta) => Math.round((aFecha(hasta) - aFecha(desde)) / 86400000) + 1;

/** El mismo día `meses` meses antes; si ese mes es más corto, su último día */
function restarMeses(iso, meses) {
  const [anio, mes, dia] = iso.split('-').map(Number);
  const indice = anio * 12 + (mes - 1) - meses;
  const anioDestino = Math.floor(indice / 12);
  const mesDestino = indice - anioDestino * 12;
  const ultimoDia = new Date(Date.UTC(anioDestino, mesDestino + 1, 0)).getUTCDate();
  return aISO(new Date(Date.UTC(anioDestino, mesDestino, Math.min(dia, ultimoDia))));
}

module.exports = { ZONA_HUEJUTLA, dos, diaHuejutla, horaHuejutla, sumarDias, diasEntre, restarMeses };
