// utils/riesgoCancelacion.js — Puntaje de riesgo de cancelación por pedido
//
// Clasificación binaria (cancelado / no cancelado) con función logística:
// z = intercepto + Σ (peso_i · variable_i) y probabilidad = 1 / (1 + e^-z).
// Todas las variables se extraen EN VIVO de la base de datos real.
//
// Pesos iniciales del clasificador; se reemplazan por los coeficientes
// entrenados cuando el sistema acumule cancelaciones reales — la
// interfaz no cambia.

const INTERCEPTO = -1.7;

// Hora local del negocio (México, UTC-6 fijo: sin horario de verano)
function horaLocal(fecha) {
  const d = new Date(fecha);
  return (d.getUTCHours() - 6 + 24) % 24;
}

function diaSemanaLocal(fecha) {
  const d = new Date(fecha);
  d.setUTCHours(d.getUTCHours() - 6);
  return d.getUTCDay(); // 0 = domingo … 6 = sábado
}

/**
 * @param {object} p Datos reales del pedido y su cliente:
 *   total, num_items, tipo_entrega, metodo_pago, created_at,
 *   horario_recogida, horario_entrega, cliente_desde,
 *   pedidos_previos, cancelaciones_previas
 * @returns {{ probabilidad: number, nivel: 'bajo'|'medio'|'alto', factores: string[] }}
 */
function calcularRiesgo(p) {
  const factores = []; // { etiqueta, peso } solo de términos que SUBEN el riesgo
  let z = INTERCEPTO;

  const sumar = (peso, etiqueta) => {
    z += peso;
    if (peso > 0 && etiqueta) factores.push({ etiqueta, peso });
  };

  // Historial del cliente
  const previos = Number(p.pedidos_previos) || 0;
  if (previos === 0) sumar(1.2, 'Cliente sin pedidos previos');
  else if (previos <= 3) sumar(0.6, `Cliente con ${previos} pedido${previos === 1 ? '' : 's'} previo${previos === 1 ? '' : 's'}`);
  else if (previos >= 15) sumar(-0.7, null);

  const cancelaciones = Number(p.cancelaciones_previas) || 0;
  if (cancelaciones > 0) sumar(0.8 * Math.min(cancelaciones, 2), `Canceló ${cancelaciones} pedido${cancelaciones === 1 ? '' : 's'} antes`);

  const antiguedadDias = p.cliente_desde
    ? Math.floor((Date.now() - new Date(p.cliente_desde).getTime()) / 86400000)
    : 0;
  if (antiguedadDias > 90) sumar(-0.4, null);

  // El pedido en sí
  const total = parseFloat(p.total) || 0;
  if (total >= 800) sumar(0.9, `Monto alto ($${Math.round(total).toLocaleString('es-MX')})`);
  else if (total >= 400) sumar(0.4, 'Monto medio');

  const numItems = Number(p.num_items) || 0;
  if (numItems >= 5) sumar(0.3, `Pedido grande (${numItems} productos)`);

  if (p.metodo_pago === 'efectivo') sumar(0.5, 'Pago en efectivo');

  const hora = horaLocal(p.created_at);
  if (hora >= 20) sumar(0.5, 'Cerca del cierre');
  else if ((hora >= 12 && hora < 14) || (hora >= 18 && hora < 20)) sumar(0.3, 'Hora pico');

  const dia = diaSemanaLocal(p.created_at);
  if (dia === 0 || dia === 6) sumar(0.2, 'Fin de semana');

  if (p.tipo_entrega === 'domicilio') sumar(0.4, 'Envío a domicilio');

  const horarioProgramado = p.horario_entrega || p.horario_recogida;
  if (horarioProgramado) {
    const horasAnticipacion = (new Date(horarioProgramado).getTime() - new Date(p.created_at).getTime()) / 3600000;
    if (horasAnticipacion > 24) sumar(0.5, 'Programado con anticipación');
  }

  const probabilidad = Math.round((1 / (1 + Math.exp(-z))) * 100);
  const nivel = probabilidad < 30 ? 'bajo' : probabilidad <= 60 ? 'medio' : 'alto';

  factores.sort((a, b) => b.peso - a.peso);
  return { probabilidad, nivel, factores: factores.slice(0, 3).map(f => f.etiqueta) };
}

module.exports = { calcularRiesgo };
