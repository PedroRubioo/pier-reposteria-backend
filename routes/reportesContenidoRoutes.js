// routes/reportesContenidoRoutes.js — Reportes de contenido (Google Play)
//
// Google Play pide que los usuarios puedan reportar lo que publican otros
// usuarios. El cliente reporta desde la app una reseña de producto o un
// comentario de «Novedades»; el personal lo atiende en Atención a clientes →
// Reportes: retira el contenido (la reseña deja de publicarse y se le avisa a
// su autor; el comentario se oculta) o lo mantiene. Tabla core.tblreportes
// (migrations/012_reportes_contenido.sql). Se monta en /api con las rutas
// completas, para que las del cliente queden junto a las de reseñas y
// comentarios que ya usa la app.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { textoLibre, enteroPositivo } = require('../utils/validacionCliente');
const { crearNotificacion, notificarRoles } = require('../services/notificacionHelper');

// ══════════════════════════════════════
// REGLAS
// ══════════════════════════════════════

// Reporta el cliente; atiende el mismo personal que modera reseñas y comentarios
const PERSONAL = ['empleado', 'gerencia', 'direccion_general'];
const SOLO_CLIENTE = accesoVigente(['cliente']);
const SOLO_PERSONAL = accesoVigente(PERSONAL);

/** Motivos que ofrece la app (NOTA_PARA_PEDRO §29), con su texto para el aviso al personal */
const MOTIVOS = {
  ofensivo: 'ofensivo',
  spam: 'spam o publicidad',
  datos_personales: 'datos personales',
  fuera_de_tema: 'fuera de tema',
  otro: 'otro motivo',
};
const ESTADOS = ['pendiente', 'atendido', 'descartado'];
const MAX_DETALLE = 500;
// Lo que se le avisa al autor de una reseña retirada, como al rechazarla
const MOTIVO_RETIRO = { min: 10, max: 500 };
// Antiabuso: reportes por cliente en la última hora
const MAX_REPORTES_POR_HORA = 20;
// Contenidos (cada uno con sus reportes) por consulta del personal
const MAX_GRUPOS = 100;

// Cada tipo de contenido: su columna, cómo se lee y sus mensajes
const CONTENIDOS = {
  resena: {
    columna: 'resena_id',
    // Solo lo publicado se puede reportar: es lo único que ven los demás
    sqlLeer: "SELECT usuario_id, estado = 'aprobada' AS visible FROM core.tblresenas WHERE id = $1",
    noEncontrado: 'La reseña no existe o ya no está publicada',
    propio: 'No puedes reportar tu propia reseña',
    repetido: 'Ya reportaste esta reseña; la estamos revisando.',
    gracias: 'Gracias por avisarnos. Revisaremos la reseña.',
    aviso: 'una reseña',
  },
  comentario: {
    columna: 'comentario_id',
    sqlLeer: `SELECT c.usuario_id, (NOT c.oculto AND p.estado = 'publicada') AS visible
              FROM core.tblpublicacion_comentarios c
              JOIN core.tblpublicaciones p ON p.id = c.publicacion_id
              WHERE c.id = $1`,
    noEncontrado: 'El comentario no existe o ya no está publicado',
    propio: 'No puedes reportar tu propio comentario',
    repetido: 'Ya reportaste este comentario; lo estamos revisando.',
    gracias: 'Gracias por avisarnos. Revisaremos el comentario.',
    aviso: 'un comentario de Novedades',
  },
};
const TIPOS = Object.keys(CONTENIDOS);

// ══════════════════════════════════════
// AUXILIARES
// ══════════════════════════════════════

/** { motivo, detalle } del cuerpo, o { error } */
function validarReporte(cuerpo) {
  const motivo = cuerpo?.motivo;
  if (typeof motivo !== 'string' || !Object.keys(MOTIVOS).includes(motivo)) {
    return { error: 'Elige el motivo del reporte' };
  }
  const detalle = textoLibre(cuerpo.detalle, { max: MAX_DETALLE, opcional: true });
  if (!detalle.ok) return { error: `El detalle puede tener hasta ${MAX_DETALLE} caracteres` };
  return { motivo, detalle: detalle.valor };
}

/**
 * Aviso al personal solo con el PRIMER reporte pendiente de un contenido: si
 * diez clientes reportan lo mismo, llega un aviso. Nunca lanza.
 */
async function avisarAlPersonal(tipo, contenidoId, reporte) {
  try {
    const { columna, aviso } = CONTENIDOS[tipo];
    const { rows: [{ primero }] } = await pool.query(
      `SELECT MIN(id) = $2 AS primero FROM core.tblreportes WHERE ${columna} = $1 AND estado = 'pendiente'`,
      [contenidoId, reporte.id]
    );
    if (!primero) return;
    await notificarRoles(PERSONAL, {
      tipo: 'aviso',
      titulo: 'Contenido reportado',
      mensaje: `Un cliente reportó ${aviso} (${MOTIVOS[reporte.motivo]}). Revísalo en Atención a clientes → Reportes.`,
    });
  } catch (error) {
    console.error('Error avisando al personal de un reporte:', error.message);
  }
}

/** En el catch: si la conexión se cayó, ROLLBACK también falla y no debe tapar el error original */
async function deshacer(client) {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    console.error('ROLLBACK de reportes falló:', error.message);
  }
}

// ══════════════════════════════════════
// REPORTAR (cliente)
// ══════════════════════════════════════

/**
 * POST .../:id/reportes { motivo, detalle? }: 201 con el reporte; 403 si el
 * contenido es suyo; 404 si no existe o ya no está publicado; 409
 * YA_REPORTADO si ya lo había reportado.
 */
function reportar(tipo) {
  const contenido = CONTENIDOS[tipo];
  return async (req, res) => {
    const id = enteroPositivo(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: contenido.noEncontrado });
    const datos = validarReporte(req.body);
    if (datos.error) {
      return res.status(400).json({ success: false, message: datos.error, motivos: Object.keys(MOTIVOS) });
    }
    try {
      const { rows: [actual] } = await pool.query(contenido.sqlLeer, [id]);
      if (!actual || !actual.visible) return res.status(404).json({ success: false, message: contenido.noEncontrado });
      if (actual.usuario_id === req.usuario.id) return res.status(403).json({ success: false, message: contenido.propio });

      const { rows: [{ recientes }] } = await pool.query(
        `SELECT COUNT(*)::int AS recientes FROM core.tblreportes
         WHERE usuario_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [req.usuario.id]
      );
      if (recientes >= MAX_REPORTES_POR_HORA) {
        return res.status(429).json({ success: false, message: 'Enviaste muchos reportes seguidos. Intenta de nuevo más tarde.' });
      }

      // Sin duplicados: el índice único (contenido, usuario) descarta el segundo
      const { rows: [reporte] } = await pool.query(
        `INSERT INTO core.tblreportes (tipo, ${contenido.columna}, usuario_id, motivo, detalle)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id, tipo, motivo, estado, created_at`,
        [tipo, id, req.usuario.id, datos.motivo, datos.detalle]
      );
      if (!reporte) {
        return res.status(409).json({ success: false, codigo: 'YA_REPORTADO', message: contenido.repetido });
      }
      res.status(201).json({ success: true, message: contenido.gracias, reporte });
      avisarAlPersonal(tipo, id, reporte);
    } catch (error) {
      // El contenido se borró entre la lectura y el INSERT
      if (error.code === '23503') return res.status(404).json({ success: false, message: contenido.noEncontrado });
      console.error(`Error POST reporte de ${tipo}:`, error.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'No se pudo enviar el reporte' });
    }
  };
}

router.post('/resenas/:id/reportes', SOLO_CLIENTE, reportar('resena'));
router.post('/publicaciones/comentarios/:id/reportes', SOLO_CLIENTE, reportar('comentario'));

// ══════════════════════════════════════
// ATENDER (personal)
// ══════════════════════════════════════

// Un contenido por fila con sus reportes de ese estado, y la reseña o el
// comentario como están hoy en la base
const SQL_GRUPOS = `
  WITH grupos AS (
    SELECT tipo, resena_id, comentario_id,
           COUNT(*)::int AS total,
           MAX(created_at) AS ultimo_reporte,
           MAX(atendido_at) AS atendido_at,
           (ARRAY_AGG(atendido_por ORDER BY atendido_at DESC NULLS LAST))[1] AS atendido_por,
           JSON_AGG(JSON_BUILD_OBJECT('motivo', motivo, 'detalle', detalle, 'created_at', created_at)
                    ORDER BY created_at DESC) AS reportes
    FROM core.tblreportes
    WHERE estado = $1
    GROUP BY tipo, resena_id, comentario_id
    ORDER BY MAX(created_at) DESC
    LIMIT $2
  )
  SELECT g.tipo, COALESCE(g.resena_id, g.comentario_id) AS contenido_id, g.total, g.ultimo_reporte,
         g.atendido_at, NULLIF(TRIM(CONCAT_WS(' ', a.nombre, a.apellido)), '') AS atendido_por_nombre,
         g.reportes,
         CASE WHEN g.tipo = 'resena' THEN r.estado = 'aprobada'
              ELSE NOT c.oculto AND pu.estado = 'publicada' END AS visible,
         COALESCE(r.comentario, c.texto) AS texto, r.titulo, r.rating,
         COALESCE(r.created_at, c.created_at) AS publicado_at,
         NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido)), '') AS autor,
         COALESCE(c.es_oficial, false) AS es_oficial,
         r.producto_id, pr.nombre AS producto_nombre,
         c.publicacion_id, LEFT(pu.texto, 140) AS publicacion_texto
  FROM grupos g
  LEFT JOIN core.tblresenas r ON r.id = g.resena_id
  LEFT JOIN core.tblproductos pr ON pr.id = r.producto_id
  LEFT JOIN core.tblpublicacion_comentarios c ON c.id = g.comentario_id
  LEFT JOIN core.tblpublicaciones pu ON pu.id = c.publicacion_id
  LEFT JOIN core.tblusuarios u ON u.id = COALESCE(r.usuario_id, c.usuario_id)
  LEFT JOIN core.tblusuarios a ON a.id = g.atendido_por
  ORDER BY g.ultimo_reporte DESC`;

// ── Lo reportado, agrupado por contenido: ?estado=pendiente (omisión) | atendido | descartado ──
router.get('/reportes-contenido', SOLO_PERSONAL, async (req, res) => {
  const estado = req.query.estado === undefined ? 'pendiente' : req.query.estado;
  if (!ESTADOS.includes(estado)) {
    return res.status(400).json({ success: false, message: 'Estado: pendiente, atendido o descartado' });
  }
  try {
    const { rows } = await pool.query(SQL_GRUPOS, [estado, MAX_GRUPOS]);
    res.json({ success: true, reportes: rows });
  } catch (error) {
    // Sin la migración 012 la tabla no existe: que la pestaña lo diga
    if (error.code === '42P01') {
      return res.status(503).json({ success: false, message: 'Los reportes aún no están activos: falta aplicar la migración 012 en la base.' });
    }
    console.error('Error GET /reportes-contenido:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener los reportes' });
  }
});

// ── Atender los reportes pendientes de un contenido: { accion: 'retirar' | 'mantener', motivo } ──
// Retirar deja de publicar la reseña (motivo: lo que se le avisa a su autor)
// u oculta el comentario, y marca sus reportes como atendidos; si ya no
// estaba publicado, solo los marca. Mantener los marca como descartados.
// La respuesta del negocio a la reseña se conserva (PUT /resenas/:id/estado
// la borraría al rechazar).
router.put('/reportes-contenido/:tipo/:id', SOLO_PERSONAL, async (req, res) => {
  const tipo = TIPOS.includes(req.params.tipo) ? req.params.tipo : null;
  const id = enteroPositivo(req.params.id);
  if (!tipo || !id) return res.status(404).json({ success: false, message: 'No hay reportes de ese contenido' });
  const accion = req.body?.accion;
  if (accion !== 'retirar' && accion !== 'mantener') {
    return res.status(400).json({ success: false, message: 'Acción: retirar o mantener' });
  }
  // Lo que se le avisa al autor: obligatorio solo al retirar una reseña que sigue publicada
  const motivoInvalido = () => res.status(400).json({
    success: false,
    message: `Escribe el motivo para su autor (de ${MOTIVO_RETIRO.min} a ${MOTIVO_RETIRO.max} caracteres)`,
  });
  const limpio = textoLibre(req.body.motivo, { ...MOTIVO_RETIRO, opcional: true });
  if (!limpio.ok) return motivoInvalido();
  const motivo = limpio.valor;
  const { columna } = CONTENIDOS[tipo];

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Los pendientes se bloquean: dos personas no atienden lo mismo a la vez
    const { rows: pendientes } = await client.query(
      `SELECT id FROM core.tblreportes WHERE ${columna} = $1 AND estado = 'pendiente' FOR UPDATE`,
      [id]
    );
    if (pendientes.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Estos reportes ya se atendieron. Recarga la lista.' });
    }

    // Retirar cambia el contenido solo si sigue publicado
    let retirado = null;
    if (accion === 'retirar' && tipo === 'resena') {
      const { rows: [resena] } = await client.query('SELECT estado FROM core.tblresenas WHERE id = $1 FOR UPDATE', [id]);
      if (resena?.estado === 'aprobada') {
        if (!motivo) {
          await client.query('ROLLBACK');
          return motivoInvalido();
        }
        const { rows } = await client.query(
          `UPDATE core.tblresenas r SET estado = 'rechazada', motivo_rechazo = $2, updated_at = NOW()
           FROM core.tblproductos p, core.tblusuarios u
           WHERE r.id = $1 AND r.estado = 'aprobada' AND p.id = r.producto_id AND u.id = r.usuario_id
           RETURNING r.usuario_id, r.rating, p.nombre AS producto_nombre, u.activo AS autor_activo`,
          [id, motivo]
        );
        retirado = rows[0] || null;
      }
    } else if (accion === 'retirar') {
      const { rows } = await client.query(
        `UPDATE core.tblpublicacion_comentarios c SET oculto = true, oculto_por = $2, oculto_motivo = 'moderacion'
         FROM core.tblusuarios u
         WHERE c.id = $1 AND NOT c.oculto AND u.id = c.usuario_id
         RETURNING c.publicacion_id, c.texto, u.nombre, u.apellido`,
        [id, req.usuario.id]
      );
      retirado = rows[0] || null;
    }
    await client.query(
      `UPDATE core.tblreportes SET estado = $2, atendido_por = $3, atendido_at = NOW()
       WHERE ${columna} = $1 AND estado = 'pendiente'`,
      [id, accion === 'retirar' ? 'atendido' : 'descartado', req.usuario.id]
    );
    await client.query('COMMIT');

    const n = pendientes.length;
    const cuantos = `${n} ${n === 1 ? 'reporte' : 'reportes'}`;
    const nombreTipo = tipo === 'resena' ? 'Reseña' : 'Comentario';
    let resultado;
    if (retirado && tipo === 'resena') {
      resultado = {
        message: 'Reseña retirada; le avisamos a su autor',
        accion: 'Retiró reseña reportada',
        detalles: `"${retirado.producto_nombre}" · ${retirado.rating}/5 · ${cuantos} · ${recortar(motivo, 80)}`,
      };
    } else if (retirado) {
      resultado = {
        message: 'Comentario ocultado',
        accion: 'Ocultó comentario reportado',
        detalles: `Publicación #${retirado.publicacion_id} · ${retirado.nombre} ${retirado.apellido} · ${recortar(retirado.texto, 80)} · ${cuantos}`,
      };
    } else if (accion === 'retirar') {
      resultado = {
        message: 'Reportes atendidos (ya no estaba publicado)',
        accion: 'Atendió reportes',
        detalles: `${nombreTipo} #${id} ya no publicado · ${cuantos}`,
      };
    } else {
      resultado = {
        message: 'Se mantiene publicado; reportes descartados',
        accion: 'Descartó reportes',
        detalles: `${nombreTipo} #${id} · ${cuantos}`,
      };
    }
    res.json({ success: true, message: resultado.message, atendidos: n, retirado: Boolean(retirado) });

    registrarAuditoria({
      usuario_id: req.usuario.id, accion: resultado.accion, entidad: tipo, entidad_id: id,
      detalles: resultado.detalles, ip: req.ip,
    });
    // Como al rechazarla: su autor sabe por qué ya no se ve (si la cuenta sigue activa)
    if (retirado && tipo === 'resena' && retirado.autor_activo) {
      crearNotificacion({
        usuario_id: retirado.usuario_id,
        tipo: 'sistema',
        titulo: 'Retiramos tu reseña',
        mensaje: `Tu reseña sobre "${retirado.producto_nombre}" ya no está publicada. Motivo: ${motivo}`,
      });
    }
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /reportes-contenido:', error.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'No se pudieron atender los reportes' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
