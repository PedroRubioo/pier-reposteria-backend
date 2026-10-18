// routes/reportesRoutes.js — Reportes (lee vistas del esquema reports)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { PERIODOS, resumenDelPeriodo, reporteVentas } = require('../utils/ventasReportes');
const { diaHuejutla, sumarDias, diasEntre } = require('../utils/fechasHuejutla');

// Listar vistas disponibles
router.get('/vistas', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name AS vista FROM information_schema.views WHERE table_schema = 'reports' ORDER BY table_name
    `);
    res.json({ success: true, vistas: result.rows.map(r => r.vista) });
  } catch (error) {
    console.error('Error GET /reportes/vistas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener vistas' });
  }
});

// Ejecutar vista específica
router.get('/vista/:nombre', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre } = req.params;
    // actividad_reciente es la bitácora completa (con lo técnico): solo dirección
    if (nombre === 'actividad_reciente' && req.user.rol !== 'direccion_general') {
      return res.status(403).json({ success: false, message: 'No tienes permisos para acceder a este recurso' });
    }
    // Validar que la vista existe en schema reports
    const existe = await pool.query(
      "SELECT 1 FROM information_schema.views WHERE table_schema = 'reports' AND table_name = $1", [nombre]
    );
    if (existe.rows.length === 0) return res.status(404).json({ success: false, message: 'Vista no encontrada' });

    const result = await pool.query(`SELECT * FROM reports.${nombre}`);
    res.json({ success: true, vista: nombre, datos: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error GET /reportes/vista/:nombre:', error.message);
    res.status(500).json({ success: false, message: 'Error al ejecutar vista' });
  }
});

// Dashboard KPIs rápidos
router.get('/kpis', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const [ingresos, pedidos, clientes, productos] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(monto_total), 0)::NUMERIC(10,2) AS total FROM core.tblpagos WHERE estado = 'pagado'"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblpedidos"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblusuarios WHERE rol = 'cliente' AND activo = true"),
      pool.query("SELECT COUNT(*) AS total FROM core.tblproductos WHERE activo = true")
    ]);
    res.json({
      success: true,
      kpis: {
        ingresos_total: parseFloat(ingresos.rows[0].total),
        pedidos_total: parseInt(pedidos.rows[0].total),
        clientes_activos: parseInt(clientes.rows[0].total),
        productos_activos: parseInt(productos.rows[0].total)
      }
    });
  } catch (error) {
    console.error('Error GET /reportes/kpis:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener KPIs' });
  }
});

// ── Bitácora (auditoría) ──
// Lo técnico (seguridad de la BD, monitoreo y respaldos) es solo de
// dirección. Las filas viejas de seguridad, monitoreo y respaldos se
// reconocen por su acción: la primera de seguridad y las restauraciones
// anteriores a la bitácora quedaron con entidad "sistema".
const ENTIDADES_TECNICAS = ['seguridad', 'monitoreo', 'backup'];
const ACCIONES_TECNICAS = ['EXPLAIN ANALYZE', 'Prueba de acceso BD', 'Configuración de seguridad BD', 'Restauracion de backup'];
// Filtro "sin lo técnico" sobre core.tblauditoria a: las dos listas van en $1 y $2
const SIN_TECNICAS = `COALESCE(a.entidad, '') <> ALL($1::text[]) AND a.accion <> ALL($2::text[])`;

// Parámetro opcional de la URL: ausente o vacío cuenta como no enviado
const enviado = (valor) => valor !== undefined && valor !== '';

// Entero positivo que cabe en INTEGER; null si no lo es
function enteroPositivo(valor) {
  const n = typeof valor === 'string' && /^\d{1,10}$/.test(valor) ? Number(valor) : 0;
  return n >= 1 && n <= 2147483647 ? n : null;
}

// 'YYYY-MM-DD' que existe en el calendario (rechaza 2026-02-30)
function esFecha(valor) {
  const m = typeof valor === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor) : null;
  return m !== null && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === valor;
}

// Tamaño de página: entero acotado a 1..500; vacío o no numérico = 50
function limiteDe(valor) {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 500) : 50;
}

// Bitácora con filtros (entidad, usuario_id, desde/hasta) y páginas por id:
// "Cargar más" manda antes_de_id = siguiente_antes_de_id. entidades y
// personas llenan los filtros con todo lo que ese rol puede ver. La skill
// de Alexa lee accion, entidad, detalles, usuario_nombre y created_at.
router.get('/auditoria', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { entidad, usuario_id, desde, hasta, antes_de_id } = req.query;
    const usuarioId = enteroPositivo(usuario_id);
    const antesDeId = enteroPositivo(antes_de_id);
    if (enviado(usuario_id) && !usuarioId) return res.status(400).json({ success: false, message: 'usuario_id inválido: debe ser un entero mayor que 0' });
    if (enviado(desde) && !esFecha(desde)) return res.status(400).json({ success: false, message: 'Fecha "desde" inválida: usa el formato AAAA-MM-DD' });
    if (enviado(hasta) && !esFecha(hasta)) return res.status(400).json({ success: false, message: 'Fecha "hasta" inválida: usa el formato AAAA-MM-DD' });
    if (enviado(antes_de_id) && !antesDeId) return res.status(400).json({ success: false, message: 'antes_de_id inválido: debe ser un entero mayor que 0' });
    const limite = limiteDe(req.query.limite);

    // Lo que el rol puede ver: dirección todo; gerencia, sin lo técnico
    const esDireccion = req.user.rol === 'direccion_general';
    const visibles = esDireccion ? 'TRUE' : SIN_TECNICAS;
    const paramsVisibles = esDireccion ? [] : [ENTIDADES_TECNICAS, ACCIONES_TECNICAS];

    // En el SQL solo van marcadores $n; los valores, en params
    const params = [...paramsVisibles];
    const condiciones = [visibles];
    const param = (valor) => { params.push(valor); return `$${params.length}`; };
    if (enviado(entidad)) {
      // Ninguna entidad pasa de 40 caracteres: un valor así no coincide con nada
      condiciones.push(typeof entidad === 'string' && entidad.length <= 40 ? `a.entidad = ${param(entidad)}` : 'FALSE');
    }
    if (usuarioId) condiciones.push(`a.usuario_id = ${param(usuarioId)}`);
    // Días completos en hora de Huejutla, ambos inclusive
    if (esFecha(desde)) condiciones.push(`a.created_at >= (${param(desde)}::date)::timestamp AT TIME ZONE 'America/Mexico_City'`);
    if (esFecha(hasta)) condiciones.push(`a.created_at < (${param(hasta)}::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City'`);
    if (antesDeId) condiciones.push(`a.id < ${param(antesDeId)}`);
    // Una fila de más dice si queda otra página
    const marcadorLimite = param(limite + 1);

    const [filasR, entidadesR, personasR] = await Promise.all([
      // detalles siempre como texto: un escalar sin comillas, un objeto como JSON
      pool.query(`SELECT a.id, a.usuario_id, a.accion, a.entidad, a.entidad_id, a.detalles #>> '{}' AS detalles, a.ip, a.created_at,
                         u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, u.rol::text AS usuario_rol
                  FROM core.tblauditoria a LEFT JOIN core.tblusuarios u ON u.id = a.usuario_id
                  WHERE ${condiciones.join(' AND ')}
                  ORDER BY a.id DESC LIMIT ${marcadorLimite}`, params),
      pool.query(`SELECT DISTINCT a.entidad FROM core.tblauditoria a
                  WHERE ${visibles} AND a.entidad IS NOT NULL ORDER BY a.entidad`, paramsVisibles),
      pool.query(`SELECT u.id, u.nombre, u.apellido, u.rol::text AS rol FROM core.tblusuarios u
                  WHERE EXISTS (SELECT 1 FROM core.tblauditoria a WHERE a.usuario_id = u.id AND ${visibles})
                  ORDER BY u.nombre, u.apellido, u.id`, paramsVisibles),
    ]);

    const hayMas = filasR.rows.length > limite;
    const auditoria = hayMas ? filasR.rows.slice(0, limite) : filasR.rows;
    res.json({
      success: true,
      auditoria,
      hay_mas: hayMas,
      siguiente_antes_de_id: hayMas ? auditoria[auditoria.length - 1].id : null,
      entidades: entidadesR.rows.map(r => r.entidad),
      personas: personasR.rows,
    });
  } catch (error) {
    console.error('Error GET /reportes/auditoria:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener auditoría' });
  }
});

// ── Actividad del equipo (gerencia y dirección general) ──
// Todo calculado en vivo: quién está activo, qué movimientos registró
// cada quien (auditoría de negocio, sin lo técnico), entregas por
// repartidor, zonas con más envíos y avisos de demora.
router.get('/actividad-equipo', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const tecnicas = [ENTIDADES_TECNICAS, ACCIONES_TECNICAS];
    const [equipoR, accionesR, entregasR, movimientosR, zonasR, kpisR] = await Promise.all([
      // rol como texto: no falla en una base que aún no tenga los roles de
      // producción (migración 010 pendiente)
      pool.query(`SELECT id, nombre, apellido, rol, activo, ultimo_acceso
                  FROM core.tblusuarios WHERE rol::text IN ('empleado', 'gerencia', 'repartidor', 'hornos', 'decoracion') ORDER BY rol, nombre`),
      pool.query(`SELECT a.usuario_id, COUNT(*)::int AS acciones, MAX(a.created_at) AS ultima_accion
                  FROM core.tblauditoria a
                  WHERE a.usuario_id IS NOT NULL AND ${SIN_TECNICAS}
                  GROUP BY a.usuario_id`, tecnicas),
      pool.query(`SELECT repartidor_id,
                         COUNT(*) FILTER (WHERE estado = 'entregada')::int AS entregadas,
                         COUNT(*) FILTER (WHERE estado IN ('asignada', 'en_camino'))::int AS activas
                  FROM core.tblentregas GROUP BY repartidor_id`),
      pool.query(`SELECT a.accion, a.entidad, a.entidad_id, a.detalles #>> '{}' AS detalles, a.created_at, u.nombre, u.apellido, u.rol
                  FROM core.tblauditoria a LEFT JOIN core.tblusuarios u ON u.id = a.usuario_id
                  WHERE ${SIN_TECNICAS}
                  ORDER BY a.created_at DESC LIMIT 30`, tecnicas),
      pool.query(`SELECT direccion_entrega->>'zona' AS zona, direccion_entrega->>'colonia' AS colonia, COUNT(*)::int AS pedidos
                  FROM core.tblpedidos
                  WHERE tipo_entrega = 'domicilio' AND direccion_entrega IS NOT NULL AND estado <> 'cancelado'
                  GROUP BY 1, 2 ORDER BY pedidos DESC LIMIT 8`),
      pool.query(`SELECT
                    (SELECT COUNT(*)::int FROM core.tblnotificaciones WHERE titulo = 'Tu pedido tardará un poco más') AS avisos_demora,
                    (SELECT COUNT(DISTINCT usuario_id)::int FROM core.tblpedidos WHERE created_at > NOW() - INTERVAL '30 days' AND estado <> 'cancelado') AS clientes_atendidos_30d,
                    (SELECT COUNT(*)::int FROM core.tblpedidos WHERE created_at > NOW() - INTERVAL '30 days' AND estado IN ('completado', 'entregado')) AS pedidos_cerrados_30d,
                    (SELECT COUNT(*)::int FROM core.tblproductos WHERE updated_at > NOW() - INTERVAL '30 days') AS productos_movidos_30d,
                    (SELECT COUNT(*)::int FROM core.tblpromociones WHERE created_at > NOW() - INTERVAL '30 days') AS promos_creadas_30d`),
    ]);

    const accionesPor = new Map(accionesR.rows.map(r => [r.usuario_id, r]));
    const entregasPor = new Map(entregasR.rows.map(r => [r.repartidor_id, r]));
    const equipo = equipoR.rows.map(u => ({
      ...u,
      acciones: accionesPor.get(u.id)?.acciones || 0,
      ultima_accion: accionesPor.get(u.id)?.ultima_accion || null,
      entregadas: entregasPor.get(u.id)?.entregadas || 0,
      entregas_activas: entregasPor.get(u.id)?.activas || 0,
    }));

    res.json({ success: true, equipo, movimientos: movimientosR.rows, zonas: zonasR.rows, kpis: kpisR.rows[0] });
  } catch (error) {
    console.error('Error GET /reportes/actividad-equipo:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener la actividad del equipo' });
  }
});

// ── Resumen y reporte de ventas (Diseno_Panel_Direccion.md §4.1 y §4.2) ──
// Las definiciones están en utils/ventasReportes.js. El rol se lee de la
// base en cada petición, no del JWT.
const VENTAS_ACCESO = accesoVigente(['gerencia', 'direccion_general']);
const RANGO_MAXIMO_DIAS = 366;

// ?periodo=mes|trimestre|anio (mes si no se envía)
router.get('/resumen', VENTAS_ACCESO, async (req, res) => {
  try {
    const periodo = enviado(req.query.periodo) ? req.query.periodo : 'mes';
    if (!PERIODOS.includes(periodo)) {
      return res.status(400).json({ success: false, message: 'Periodo inválido: usa mes, trimestre o anio' });
    }
    res.json({ success: true, ...(await resumenDelPeriodo(periodo)) });
  } catch (error) {
    console.error('Error GET /reportes/resumen:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el resumen' });
  }
});

// ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (por defecto, los últimos 30 días)
router.get('/ventas', VENTAS_ACCESO, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (enviado(desde) && !esFecha(desde)) return res.status(400).json({ success: false, message: 'Fecha "desde" inválida: usa el formato AAAA-MM-DD' });
    if (enviado(hasta) && !esFecha(hasta)) return res.status(400).json({ success: false, message: 'Fecha "hasta" inválida: usa el formato AAAA-MM-DD' });
    const fin = enviado(hasta) ? hasta : diaHuejutla();
    const inicio = enviado(desde) ? desde : sumarDias(fin, -29);
    if (inicio > fin) return res.status(400).json({ success: false, message: 'La fecha "desde" no puede ser posterior a "hasta"' });
    if (diasEntre(inicio, fin) > RANGO_MAXIMO_DIAS) {
      return res.status(400).json({ success: false, message: `El rango máximo es de ${RANGO_MAXIMO_DIAS} días` });
    }
    res.json({ success: true, ...(await reporteVentas(inicio, fin)) });
  } catch (error) {
    console.error('Error GET /reportes/ventas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el reporte de ventas' });
  }
});

module.exports = router;