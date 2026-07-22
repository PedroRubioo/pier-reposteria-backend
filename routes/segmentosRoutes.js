// routes/segmentosRoutes.js — Segmentación de clientes (RFM extendido + K-Means)
//
// Calculado 100% de los datos reales: una fila por cliente (rol cliente,
// pedidos no cancelados) con recencia, frecuencia, monto y las variables
// extendidas ticket_prom, antiguedad y prod_dist. Las seis variables se
// estandarizan (media 0, desviación 1) y K-Means con k=3 encuentra los
// grupos; las etiquetas de negocio se asignan por perfil: mayor monto
// promedio → VIP, mayor recencia promedio → inactivos, el resto →
// ocasionales. Inicialización determinista para que los segmentos no
// cambien entre refrescos con los mismos datos.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

const TTL_CACHE_MS = 10 * 60 * 1000;
let cache = { calculadoEn: 0, respuesta: null };

function estandarizar(matriz) {
  const dims = matriz[0].length;
  const medias = new Array(dims).fill(0);
  const desviaciones = new Array(dims).fill(0);
  for (const fila of matriz) fila.forEach((v, d) => { medias[d] += v; });
  medias.forEach((s, d) => { medias[d] = s / matriz.length; });
  for (const fila of matriz) fila.forEach((v, d) => { desviaciones[d] += (v - medias[d]) ** 2; });
  desviaciones.forEach((s, d) => { desviaciones[d] = Math.sqrt(s / matriz.length); });
  return matriz.map(fila => fila.map((v, d) => (desviaciones[d] > 0 ? (v - medias[d]) / desviaciones[d] : 0)));
}

function distancia2(a, b) {
  let suma = 0;
  for (let d = 0; d < a.length; d++) suma += (a[d] - b[d]) ** 2;
  return suma;
}

function kmeans(puntos, k) {
  // Centroides iniciales deterministas: puntos equiespaciados tras ordenar
  // por la suma de sus variables estandarizadas
  const orden = puntos
    .map((v, i) => ({ i, s: v.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => a.s - b.s);
  let centroides = Array.from({ length: k }, (_, j) =>
    puntos[orden[Math.min(puntos.length - 1, Math.floor((j + 0.5) * puntos.length / k))].i].slice()
  );

  const asignacion = new Array(puntos.length).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    let cambio = false;
    for (let i = 0; i < puntos.length; i++) {
      let mejor = 0;
      let mejorDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = distancia2(puntos[i], centroides[c]);
        if (dist < mejorDist) { mejorDist = dist; mejor = c; }
      }
      if (asignacion[i] !== mejor) { asignacion[i] = mejor; cambio = true; }
    }
    const sumas = Array.from({ length: k }, () => new Array(puntos[0].length).fill(0));
    const cuentas = new Array(k).fill(0);
    for (let i = 0; i < puntos.length; i++) {
      cuentas[asignacion[i]]++;
      puntos[i].forEach((v, d) => { sumas[asignacion[i]][d] += v; });
    }
    centroides = centroides.map((c, idx) => (cuentas[idx] > 0 ? sumas[idx].map(s => s / cuentas[idx]) : c));
    if (!cambio) break;
  }
  return asignacion;
}

async function calcularSegmentos() {
  if (cache.respuesta && Date.now() - cache.calculadoEn < TTL_CACHE_MS) return cache.respuesta;

  const [pedidosRes, productosRes] = await Promise.all([
    pool.query(`
      SELECT p.usuario_id, MAX(p.created_at) AS ultima_compra, MIN(p.created_at) AS primera_compra,
             COUNT(*)::int AS frecuencia, SUM(p.total)::float AS monto_total
      FROM core.tblpedidos p
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE u.rol = 'cliente' AND p.estado <> 'cancelado'
      GROUP BY p.usuario_id
    `),
    pool.query(`
      SELECT p.usuario_id, COUNT(DISTINCT i.producto_id)::int AS prod_dist
      FROM core.tblpedidos p
      JOIN core.tblpedido_items i ON i.pedido_id = p.id
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE u.rol = 'cliente' AND p.estado <> 'cancelado'
      GROUP BY p.usuario_id
    `),
  ]);

  const prodPorCliente = new Map(productosRes.rows.map(r => [r.usuario_id, r.prod_dist]));
  const ahora = Date.now();
  const clientes = pedidosRes.rows.map(r => ({
    recencia: Math.floor((ahora - new Date(r.ultima_compra).getTime()) / 86400000),
    frecuencia: r.frecuencia,
    monto: r.monto_total,
    ticket_prom: r.monto_total / r.frecuencia,
    antiguedad: Math.floor((ahora - new Date(r.primera_compra).getTime()) / 86400000),
    prod_dist: prodPorCliente.get(r.usuario_id) || 0,
  }));

  if (clientes.length === 0) {
    return { total_clientes: 0, segmentos: [] };
  }

  const k = Math.min(3, clientes.length);
  const matriz = clientes.map(c => [c.recencia, c.frecuencia, c.monto, c.ticket_prom, c.antiguedad, c.prod_dist]);
  const asignacion = kmeans(estandarizar(matriz), k);

  // Perfil promedio de cada cluster (sobre valores reales, no estandarizados)
  const grupos = Array.from({ length: k }, () => []);
  clientes.forEach((c, i) => grupos[asignacion[i]].push(c));
  const perfiles = grupos.map((g, idx) => ({
    idx,
    clientes: g.length,
    recencia_prom: g.reduce((s, c) => s + c.recencia, 0) / Math.max(g.length, 1),
    frecuencia_prom: g.reduce((s, c) => s + c.frecuencia, 0) / Math.max(g.length, 1),
    monto_prom: g.reduce((s, c) => s + c.monto, 0) / Math.max(g.length, 1),
    ticket_prom: g.reduce((s, c) => s + c.ticket_prom, 0) / Math.max(g.length, 1),
    prod_dist_prom: g.reduce((s, c) => s + c.prod_dist, 0) / Math.max(g.length, 1),
  })).filter(p => p.clientes > 0);

  // Etiquetas de negocio coherentes:
  // 1) Inactivos = el cluster con MAYOR recencia promedio (los más dormidos)
  // 2) VIP = entre los restantes, el de mayor valor combinado (monto y
  //    frecuencia altos, recencia baja; métricas normalizadas 0-1)
  // 3) Ocasionales = el resto
  // Garantía: el VIP nunca puede mostrar mayor recencia promedio que
  // Inactivos, porque Inactivos se toma primero como el máximo global.
  let vip = null;
  let inactivo = null;
  let ocasionales = [];
  if (perfiles.length === 1) {
    ocasionales = perfiles;
  } else {
    inactivo = perfiles.reduce((a, b) => (b.recencia_prom > a.recencia_prom ? b : a));
    const restantes = perfiles.filter(p => p !== inactivo);
    const normalizador = (valores) => {
      const min = Math.min(...valores);
      const max = Math.max(...valores);
      return v => (max > min ? (v - min) / (max - min) : 0.5);
    };
    const nMonto = normalizador(restantes.map(p => p.monto_prom));
    const nFrecuencia = normalizador(restantes.map(p => p.frecuencia_prom));
    const nRecencia = normalizador(restantes.map(p => p.recencia_prom));
    const valorCombinado = p => nMonto(p.monto_prom) + nFrecuencia(p.frecuencia_prom) + (1 - nRecencia(p.recencia_prom));
    vip = restantes.reduce((a, b) => (valorCombinado(b) > valorCombinado(a) ? b : a));
    ocasionales = restantes.filter(p => p !== vip);
  }

  // Separación débil entre clusters (perfiles casi iguales, como con los
  // datos semilla): si 2 de las 3 métricas RFM varían menos del 15% de su
  // media entre clusters, la segmentación se marca como preliminar
  const dispersionRelativa = (valores) => {
    const media = valores.reduce((s, v) => s + v, 0) / valores.length;
    return media > 0 ? (Math.max(...valores) - Math.min(...valores)) / media : 0;
  };
  const metricasDebiles = [
    dispersionRelativa(perfiles.map(p => p.recencia_prom)),
    dispersionRelativa(perfiles.map(p => p.frecuencia_prom)),
    dispersionRelativa(perfiles.map(p => p.monto_prom)),
  ].filter(m => m < 0.15).length;
  const segmentacionPreliminar = perfiles.length < 2 || metricasDebiles >= 2;

  const aSegmento = (perfil, nombre) => ({
    nombre,
    clientes: perfil.clientes,
    porcentaje: Math.round((perfil.clientes / clientes.length) * 100),
    recencia_prom: Math.round(perfil.recencia_prom),
    frecuencia_prom: Math.round(perfil.frecuencia_prom),
    monto_prom: Math.round(perfil.monto_prom),
    ticket_prom: Math.round(perfil.ticket_prom),
    prod_dist_prom: Math.round(perfil.prod_dist_prom),
  });

  const segmentos = [];
  if (vip) segmentos.push(aSegmento(vip, 'Clientes VIP'));
  for (const p of ocasionales) segmentos.push(aSegmento(p, 'Ocasionales'));
  if (inactivo) segmentos.push(aSegmento(inactivo, 'Inactivos'));

  const respuesta = { total_clientes: clientes.length, segmentacion_preliminar: segmentacionPreliminar, segmentos };
  cache = { calculadoEn: Date.now(), respuesta };
  return respuesta;
}

router.get('/', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const datos = await calcularSegmentos();
    res.json({ success: true, ...datos });
  } catch (error) {
    console.error('Error GET /segmentos-clientes:', error.message);
    res.status(500).json({ success: false, message: 'Error al calcular segmentos' });
  }
});

module.exports = router;
module.exports.calcularSegmentos = calcularSegmentos;
