// routes/publicacionesRoutes.js — Feed del inicio del cliente
//
// Publicaciones de la repostería tipo Facebook (texto arriba, fotos o
// videos abajo) con una sola reacción ("Me encanta") y comentarios, más
// las promociones y los productos sugeridos que se intercalan en el feed.
// Publica y modera el personal; los clientes reaccionan y comentan. El
// contrato completo está en Diseno_Feed_Inicio.md (§2); las reglas puras,
// en utils/publicaciones.js.
const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { cargarUsuarioVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria } = require('../utils/auditoria');
const { obtenerSimilares } = require('../utils/recomendaciones');
const {
  MARCA, CARPETA_FEED, MAX_TEXTO_COMENTARIO, esId, recortar, limpiarTexto, nombreCorto, esPublicIdDelFeed,
  validarPublicacion, mismosMedios, resumenPublicacion, revisarVideo, etiquetaPromocion, precioPromocion,
} = require('../utils/publicaciones');

// ══════════════════════════════════════
// PERMISOS (§2.1)
// ══════════════════════════════════════

const CLIENTE = ['cliente'];
const PERSONAL = ['empleado', 'gerencia', 'direccion_general'];
// Producción (hornos, decoración) y repartidor no están en ningún grupo: 403 en todo
const LECTORES = [...CLIENTE, ...PERSONAL];

function exigirRol(roles) {
  return (req, res, next) => (roles.includes(req.usuario.rol)
    ? next()
    : res.status(403).json({ success: false, message: 'No tienes permiso para esta acción' }));
}

const acceso = (roles) => [verifyToken, cargarUsuarioVigente, exigirRol(roles)];
const PUEDE_LEER = acceso(LECTORES);
const SOLO_CLIENTE = acceso(CLIENTE);
const SOLO_PERSONAL = acceso(PERSONAL);

const esPersonal = (usuario) => PERSONAL.includes(usuario.rol);

// ══════════════════════════════════════
// AUXILIARES
// ══════════════════════════════════════

/** Id de la URL o de la consulta como entero; null si no lo es */
function idDe(valor) {
  const n = typeof valor === 'string' && /^\d{1,10}$/.test(valor) ? Number(valor) : NaN;
  return esId(n) ? n : null;
}

/** Entero de la consulta acotado a [min, max]; `omision` si no viene o no es número */
function enteroEntre(valor, min, max, omision) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : omision;
}

// ISO 8601 con zona. El cursor que arma el feed trae microsegundos: con
// milisegundos (Date de JS) la comparación por llave se saltaría publicaciones
const FORMATO_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Fecha del cursor tal cual (texto) si es válida y existe en el calendario; null si no */
function cursorFecha(valor) {
  if (typeof valor !== 'string' || !FORMATO_CURSOR.test(valor) || Number.isNaN(Date.parse(valor))) return null;
  // Date.parse acepta '2026-02-30' (lo pasa a marzo) y PostgreSQL no: el día debe existir
  const dia = valor.slice(0, 10);
  const enCalendario = new Date(`${dia}T00:00:00Z`);
  return Number(dia.slice(0, 4)) >= 1970 && !Number.isNaN(enCalendario.getTime())
    && enCalendario.toISOString().slice(0, 10) === dia
    ? valor
    : null;
}

/** 400 con todos los problemas; message es el primero */
const rechazar = (res, errores) => res.status(400).json({ success: false, message: errores[0], errores });

const noEncontrada = (res) => res.status(404).json({ success: false, message: 'Publicación no encontrada' });

/** En el catch: si la conexión se cayó, ROLLBACK también falla y no debe tapar el error original */
async function deshacer(client) {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    console.error('ROLLBACK del feed falló:', error.message);
  }
}

// Fotos y videos de la publicación p, en orden (MedioPublicacion[]). Sin
// public_id: al editar, el que ya tenía la publicación (misma URL y tipo)
// conserva el suyo guardado (validarMedio)
const SQL_MEDIOS = `
  SELECT COALESCE(json_agg(json_build_object(
           'id', x.id, 'tipo', x.tipo, 'url', x.url, 'poster_url', x.poster_url,
           'ancho', x.ancho, 'alto', x.alto, 'duracion', x.duracion) ORDER BY x.orden, x.id), '[]') AS medios
  FROM core.tblpublicacion_medios x WHERE x.publicacion_id = p.id`;

// Comentario con su autor y, si está oculto, quién lo ocultó
const SQL_COMENTARIOS = `
  SELECT c.id, c.publicacion_id, c.usuario_id, c.texto, c.es_oficial, c.oculto, c.oculto_motivo, c.created_at,
         u.nombre, u.apellido, u.avatar_url, o.nombre || ' ' || o.apellido AS oculto_por_nombre
  FROM core.tblpublicacion_comentarios c
  JOIN core.tblusuarios u ON u.id = c.usuario_id
  LEFT JOIN core.tblusuarios o ON o.id = c.oculto_por`;

/** Fila → Comentario. es_tuyo y puede_borrar dependen de quién lo pide */
function comentarioDeFila(f, usuario) {
  const esTuyo = f.usuario_id === usuario.id;
  return {
    id: f.id,
    texto: f.texto,
    created_at: f.created_at,
    es_oficial: f.es_oficial,
    // La respuesta oficial sale a nombre de la marca, sin la foto de quien la escribió
    autor: f.es_oficial
      ? { nombre: MARCA, avatar_url: null, es_tuyo: esTuyo }
      : { nombre: nombreCorto(f.nombre, f.apellido), avatar_url: f.avatar_url, es_tuyo: esTuyo },
    // El cliente oculta los suyos; el personal, cualquiera
    puede_borrar: esTuyo || esPersonal(usuario),
  };
}

/** Fila → ComentarioAdmin: además, si está oculto, quién y por qué, y el nombre completo del autor */
function comentarioAdminDeFila(f, usuario) {
  return {
    ...comentarioDeFila(f, usuario),
    oculto: f.oculto,
    oculto_motivo: f.oculto_motivo,
    oculto_por_nombre: f.oculto_por_nombre,
    autor_completo: `${f.nombre} ${f.apellido}`,
  };
}

/** Lo que el autor ocultó lo marca como suyo; lo que oculta el personal de otro, como moderación */
const motivoOcultar = (usuario, comentario) => (comentario.usuario_id === usuario.id ? 'autor' : 'moderacion');

/** Detalle de la bitácora de un comentario: 'Publicación #12 · Carla Cliente · texto recortado' */
const detalleComentario = (c) => `Publicación #${c.publicacion_id} · ${c.nombre} ${c.apellido} · ${recortar(c.texto, 80)}`;

/** Publicaciones con sus métricas para el personal (PublicacionAdmin), por id o por estado */
async function leerPublicacionesAdmin(db, { id = null, estado = null }) {
  const { rows } = await db.query(
    `SELECT p.id, p.texto, p.estado, p.editada, p.created_at, p.updated_at,
            a.nombre || ' ' || a.apellido AS autor_nombre,
            m.medios, r.corazones, c.comentarios, c.comentarios_ocultos
     FROM core.tblpublicaciones p
     JOIN core.tblusuarios a ON a.id = p.autor_id
     CROSS JOIN LATERAL (${SQL_MEDIOS}) m
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS corazones FROM core.tblpublicacion_reacciones y WHERE y.publicacion_id = p.id
     ) r
     CROSS JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE NOT z.oculto)::int AS comentarios,
              COUNT(*) FILTER (WHERE z.oculto)::int AS comentarios_ocultos
       FROM core.tblpublicacion_comentarios z WHERE z.publicacion_id = p.id
     ) c
     WHERE ($1::int IS NULL OR p.id = $1::int) AND ($2::text IS NULL OR p.estado = $2::text)
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 200`,
    // Las 200 más recientes: de sobra para el ritmo de publicación de la repostería
    [id, estado]
  );
  return rows;
}

/** Fotos y videos en un solo INSERT (jsonb_to_recordset), en el orden recibido */
async function insertarMedios(client, publicacionId, medios) {
  if (medios.length === 0) return;
  await client.query(
    `INSERT INTO core.tblpublicacion_medios (publicacion_id, tipo, url, public_id, ancho, alto, duracion, poster_url, orden)
     SELECT $1, r.tipo, r.url, r.public_id, r.ancho, r.alto, r.duracion, r.poster_url, r.orden
     FROM jsonb_to_recordset($2::jsonb) AS r(
       tipo text, url text, public_id text, ancho integer, alto integer, duracion numeric, poster_url text, orden smallint)`,
    [publicacionId, JSON.stringify(medios.map((m, i) => ({ ...m, orden: i + 1 })))]
  );
}

/** Los 2 comentarios visibles más recientes de cada publicación, en orden cronológico */
async function comentariosRecientes(ids, usuario) {
  const porPublicacion = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return porPublicacion;
  const { rows } = await pool.query(
    `SELECT c.id, c.publicacion_id, c.usuario_id, c.texto, c.es_oficial, c.created_at, u.nombre, u.apellido, u.avatar_url
     FROM unnest($1::int[]) AS pub(id)
     CROSS JOIN LATERAL (
       SELECT x.id, x.publicacion_id, x.usuario_id, x.texto, x.es_oficial, x.created_at
       FROM core.tblpublicacion_comentarios x
       WHERE x.publicacion_id = pub.id AND NOT x.oculto
       ORDER BY x.created_at DESC, x.id DESC
       LIMIT 2
     ) c
     JOIN core.tblusuarios u ON u.id = c.usuario_id
     ORDER BY c.publicacion_id, c.created_at, c.id`,
    [ids]
  );
  for (const f of rows) porPublicacion.get(f.publicacion_id).push(comentarioDeFila(f, usuario));
  return porPublicacion;
}

/** Fila de la promoción → PromocionFeed (sin codigo_descuento: no se canjea en ningún lado) */
function promocionDeFila(f) {
  let subtitulo = null;
  if (f.tipo === 'banner') subtitulo = f.subtitulo_banner || f.descripcion_banner || null;
  else if (f.tipo === 'temporada') subtitulo = f.nombre_temporada || null;
  return {
    id: f.id,
    tipo: f.tipo,
    titulo: f.tipo === 'banner' && f.titulo_banner ? f.titulo_banner : f.producto_nombre,
    subtitulo,
    etiqueta: etiquetaPromocion(f.tipo, f.badge_destacado),
    producto: {
      id: f.producto_id,
      nombre: f.producto_nombre,
      imagen_url: f.imagen_url,
      categoria: f.categoria,
      precio_grande: f.precio_grande,
    },
    descuento_porcentaje: f.descuento_porcentaje,
    precio_normal: f.precio_chico,
    precio_promocion: precioPromocion(f.precio_chico, f.descuento_porcentaje),
    fecha_fin: f.fecha_fin,
  };
}

const SUGERENCIAS_POR_PAGINA = 6;
// Primero las afines a lo que compró el cliente, luego los más pedidos; la lista termina
const MAX_AFINES = 12;
const MAX_SUGERENCIAS = 36;

/** Producto del catálogo → ProductoSugerido */
const sugerido = (p, motivo) => ({
  id: p.id,
  nombre: p.nombre,
  imagen_url: p.imagen_url,
  categoria: p.categoria,
  precio_chico: p.precio_chico,
  precio_grande: p.precio_grande,
  motivo,
});

// ══════════════════════════════════════
// FOTOS Y VIDEOS (Cloudinary)
// ══════════════════════════════════════

// Misma configuración que routes/uploadRoutes.js y comandas
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const CLOUDINARY_LISTO = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

const recibirArchivo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (TIPOS_IMAGEN.includes(file.mimetype)) return cb(null, true);
    const error = new Error('Tipo de archivo no permitido');
    error.code = 'TIPO_NO_PERMITIDO';
    return cb(error);
  },
}).single('imagen');

/**
 * multer entrega sus errores a next() y el manejador global respondería 500;
 * aquí se traducen a JSON: 413 si pesa de más, 400 si no es imagen o el
 * formulario viene mal armado.
 */
function recibirImagen(req, res, next) {
  recibirArchivo(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'La imagen pesa más de 10 MB' });
    }
    if (error.code === 'TIPO_NO_PERMITIDO') {
      return res.status(400).json({ success: false, message: 'Solo se aceptan imágenes JPG, PNG, WebP, GIF o HEIC' });
    }
    return res.status(400).json({ success: false, message: 'No se pudo leer la imagen: envíala en el campo "imagen"' });
  });
}

const exigirCloudinary = (req, res, next) => (CLOUDINARY_LISTO
  ? next()
  : res.status(503).json({ success: false, message: 'La subida de fotos y videos no está configurada (Cloudinary)' }));

function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const destino = cloudinary.uploader.upload_stream(
      {
        folder: CARPETA_FEED,
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto', format: 'webp' }],
      },
      (error, resultado) => (error ? reject(error) : resolve(resultado))
    );
    streamifier.createReadStream(buffer).pipe(destino);
  });
}

/** Cloudinary rechaza con { error: { message, http_code } } o con un Error de red */
const errorDeCloudinary = (error) => error?.error?.message ?? error?.message ?? String(error);

/** Video del feed para cualquier navegador: calidad automática y mp4 (un .mov de iPhone no lo reproduce Chrome) */
const urlVideo = (recurso) => cloudinary.url(recurso.public_id, {
  resource_type: 'video', secure: true, version: recurso.version, quality: 'auto', format: 'mp4', urlAnalytics: false,
});

/** Portada del video: su cuadro 0 en jpg */
const urlPortada = (recurso) => cloudinary.url(recurso.public_id, {
  resource_type: 'video', secure: true, version: recurso.version, start_offset: 0, format: 'jpg', urlAnalytics: false,
});

/**
 * Pide a Cloudinary que prepare ya, en segundo plano, el video y la portada
 * con las mismas transformaciones de urlVideo y urlPortada: en el plan
 * gratuito un video de más de 40 MB no se transforma al vuelo y su URL
 * fallaría. Si la petición falla, los videos chicos siguen saliendo al vuelo.
 */
async function prepararVideo(publicId) {
  try {
    await cloudinary.uploader.explicit(publicId, {
      type: 'upload',
      resource_type: 'video',
      eager: [{ quality: 'auto', format: 'mp4' }, { start_offset: 0, format: 'jpg' }],
      eager_async: true,
    });
  } catch (error) {
    console.error('No se pudieron preparar las versiones del video:', errorDeCloudinary(error));
  }
}

// ══════════════════════════════════════
// PARA EL CLIENTE (y vista previa del personal)
// ══════════════════════════════════════

// ── Feed: de la más nueva a la más vieja, por llave (created_at, id) y sin OFFSET ──
router.get('/feed', PUEDE_LEER, async (req, res) => {
  const conCursor = req.query.antes !== undefined || req.query.antes_id !== undefined;
  const antes = conCursor ? cursorFecha(req.query.antes) : null;
  const antesId = conCursor ? idDe(req.query.antes_id) : null;
  if (conCursor && (!antes || !antesId)) {
    return res.status(400).json({ success: false, message: 'No se pudo seguir el feed. Recarga el inicio.' });
  }
  const limite = enteroEntre(req.query.limite, 1, 20, 8);
  try {
    // Una de más para saber si hay otra página sin contar toda la tabla
    const { rows } = await pool.query(
      `SELECT p.id, p.texto, p.created_at, p.editada,
              to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor,
              m.medios, r.corazones, r.me_encanta, c.total_comentarios
       FROM core.tblpublicaciones p
       CROSS JOIN LATERAL (${SQL_MEDIOS}) m
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS corazones, COALESCE(bool_or(y.usuario_id = $4::int), false) AS me_encanta
         FROM core.tblpublicacion_reacciones y WHERE y.publicacion_id = p.id
       ) r
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS total_comentarios
         FROM core.tblpublicacion_comentarios z WHERE z.publicacion_id = p.id AND NOT z.oculto
       ) c
       WHERE p.estado = 'publicada'
         AND ($1::timestamptz IS NULL OR (p.created_at, p.id) < ($1::timestamptz, $2::int))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $3::int`,
      [antes, antesId, limite + 1, req.usuario.id]
    );
    const pagina = rows.slice(0, limite);
    const recientes = await comentariosRecientes(pagina.map((p) => p.id), req.usuario);
    const ultima = pagina.at(-1);
    res.json({
      success: true,
      publicaciones: pagina.map((p) => ({
        id: p.id,
        texto: p.texto,
        created_at: p.created_at,
        editada: p.editada,
        autor: { nombre: MARCA },
        medios: p.medios,
        corazones: p.corazones,
        me_encanta: p.me_encanta,
        total_comentarios: p.total_comentarios,
        comentarios_recientes: recientes.get(p.id),
      })),
      siguiente: rows.length > limite ? { antes: ultima.cursor, antes_id: ultima.id } : null,
    });
  } catch (error) {
    console.error('Error GET /publicaciones/feed:', error.message);
    res.status(500).json({ success: false, message: 'Error al cargar el inicio' });
  }
});

// ── Promociones para intercalar: vigentes, una por producto y con el precio que se cobra ──
router.get('/promociones', PUEDE_LEER, async (req, res) => {
  try {
    // Solo productos que hoy se pueden comprar; de cada uno, la promoción más reciente
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (pr.producto_id)
                pr.id, pr.tipo, pr.titulo_banner, pr.subtitulo_banner, pr.descripcion_banner, pr.nombre_temporada,
                pr.badge_destacado, pr.descuento_porcentaje, pr.fecha_fin, pr.created_at,
                p.id AS producto_id, p.nombre AS producto_nombre, p.imagen_url, c.nombre AS categoria,
                p.precio_chico, p.precio_grande
         FROM core.tblpromociones pr
         JOIN core.tblproductos p ON p.id = pr.producto_id
         JOIN core.tblcategorias c ON c.id = p.categoria_id
         WHERE pr.estado = 'activa'
           AND (pr.fecha_inicio IS NULL OR pr.fecha_inicio <= NOW())
           AND (pr.fecha_fin IS NULL OR pr.fecha_fin > NOW())
           AND p.activo AND c.activo AND p.stock_online > 0
         ORDER BY pr.producto_id, pr.created_at DESC, pr.id DESC
       ) vigentes
       ORDER BY vigentes.created_at DESC, vigentes.id DESC`
    );
    res.json({ success: true, promociones: rows.map(promocionDeFila) });
  } catch (error) {
    console.error('Error GET /publicaciones/promociones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las promociones' });
  }
});

// ── Sugerencias: afines a lo que compró el cliente y luego los más pedidos ──
router.get('/sugerencias', PUEDE_LEER, async (req, res) => {
  const pagina = enteroEntre(req.query.pagina, 1, 1000, 1);
  try {
    const [similares, compradosR, catalogoR] = await Promise.all([
      obtenerSimilares(),
      // Lo que compró quien pide (ventas consumadas, como la similitud), lo más comprado primero
      pool.query(
        `SELECT i.producto_id, p.nombre, SUM(i.cantidad)::int AS unidades
         FROM core.tblpedidos pe
         JOIN core.tblpedido_items i ON i.pedido_id = pe.id
         JOIN core.tblproductos p ON p.id = i.producto_id
         WHERE pe.usuario_id = $1 AND pe.estado IN ('completado', 'entregado')
         GROUP BY i.producto_id, p.nombre
         ORDER BY unidades DESC, i.producto_id`,
        [req.usuario.id]
      ),
      // Lo que hoy se puede comprar, con las unidades vendidas de cada producto
      pool.query(
        `SELECT p.id, p.nombre, p.imagen_url, c.nombre AS categoria, p.precio_chico, p.precio_grande,
                COALESCE(v.vendidos, 0)::int AS vendidos
         FROM core.tblproductos p
         JOIN core.tblcategorias c ON c.id = p.categoria_id
         LEFT JOIN (
           SELECT i.producto_id, SUM(i.cantidad) AS vendidos
           FROM core.tblpedido_items i JOIN core.tblpedidos pe ON pe.id = i.pedido_id
           WHERE pe.estado IN ('completado', 'entregado')
           GROUP BY i.producto_id
         ) v ON v.producto_id = p.id
         WHERE p.activo AND c.activo AND p.stock_online > 0`
      ),
    ]);
    const disponibles = new Map(catalogoR.rows.map((p) => [p.id, p]));
    const comprados = new Set(compradosR.rows.map((c) => c.producto_id));

    // Afines: cada producto con su mayor parecido a algo de lo comprado, que da el motivo
    const afines = new Map();
    for (const comprado of compradosR.rows) {
      for (const similar of similares.get(comprado.producto_id) ?? []) {
        if (comprados.has(similar.id) || !disponibles.has(similar.id)) continue;
        const previo = afines.get(similar.id);
        if (!previo || similar.score > previo.score) afines.set(similar.id, { ...similar, origen: comprado.nombre });
      }
    }
    const lista = [...afines.values()]
      .sort((a, b) => (b.score - a.score) || (b.coCompradores - a.coCompradores) || (a.id - b.id))
      .slice(0, MAX_AFINES)
      .map((a) => sugerido(disponibles.get(a.id), `Porque te gustó ${a.origen}`));

    const incluidos = new Set(lista.map((p) => p.id));
    const masPedidos = catalogoR.rows
      .filter((p) => p.vendidos > 0 && !incluidos.has(p.id))
      .sort((a, b) => (b.vendidos - a.vendidos) || (a.id - b.id));
    for (const p of masPedidos.slice(0, MAX_SUGERENCIAS - lista.length)) lista.push(sugerido(p, 'De los más pedidos'));

    const inicio = (pagina - 1) * SUGERENCIAS_POR_PAGINA;
    res.json({
      success: true,
      productos: lista.slice(inicio, inicio + SUGERENCIAS_POR_PAGINA),
      hay_mas: lista.length > inicio + SUGERENCIAS_POR_PAGINA,
    });
  } catch (error) {
    console.error('Error GET /publicaciones/sugerencias:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las sugerencias' });
  }
});

// ══════════════════════════════════════
// FOTOS Y VIDEOS DEL PERSONAL
// ══════════════════════════════════════

// ── Subir una foto (1600 px en webp, carpeta del feed) ──
router.post('/medios/imagen', SOLO_PERSONAL, exigirCloudinary, recibirImagen, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se envió ninguna imagen' });
  try {
    const resultado = await subirACloudinary(req.file.buffer);
    res.status(201).json({
      success: true,
      imagen: { url: resultado.secure_url, public_id: resultado.public_id, ancho: resultado.width, alto: resultado.height },
    });
  } catch (error) {
    console.error('Error POST /publicaciones/medios/imagen:', errorDeCloudinary(error));
    res.status(500).json({ success: false, message: 'Error al subir la imagen' });
  }
});

// ── Firma para que el navegador suba el video directo a Cloudinary (no pasa por la memoria del servidor) ──
router.post('/medios/firma-video', SOLO_PERSONAL, exigirCloudinary, (req, res) => {
  // La firma solo vale para la carpeta del feed y por una hora (regla de Cloudinary)
  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder: CARPETA_FEED }, process.env.CLOUDINARY_API_SECRET);
  res.json({
    success: true,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder: CARPETA_FEED,
  });
});

// ── Verificar el video que subió el navegador: carpeta, ≤ 100 MB y ≤ 180 s ──
router.post('/medios/video-verificar', SOLO_PERSONAL, exigirCloudinary, async (req, res) => {
  const publicId = typeof req.body?.public_id === 'string' ? req.body.public_id.trim() : '';
  // Antes de preguntar (y de borrar nada) en Cloudinary: solo la carpeta del feed
  if (!esPublicIdDelFeed(publicId)) return rechazar(res, ['El video no es de la carpeta del feed']);
  try {
    let recurso;
    try {
      // media_metadata hace que Cloudinary incluya la duración
      recurso = await cloudinary.api.resource(publicId, { resource_type: 'video', media_metadata: true });
    } catch (error) {
      if (error?.error?.http_code === 404) {
        return res.status(404).json({ success: false, message: 'No se encontró el video en Cloudinary. Vuelve a subirlo.' });
      }
      console.error('Error consultando el video en Cloudinary:', errorDeCloudinary(error));
      return res.status(502).json({ success: false, message: 'No se pudo revisar el video en Cloudinary. Inténtalo de nuevo.' });
    }
    const { errores, video } = revisarVideo(recurso);
    if (errores.length > 0) {
      // No cumple: se borra para que no quede ocupando la cuenta
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
      } catch (error) {
        console.error('No se pudo borrar el video rechazado:', errorDeCloudinary(error));
      }
      return rechazar(res, errores);
    }
    await prepararVideo(recurso.public_id);
    res.json({
      success: true,
      video: {
        tipo: 'video',
        url: urlVideo(recurso),
        public_id: recurso.public_id,
        ancho: video.ancho,
        alto: video.alto,
        duracion: video.duracion,
        poster_url: urlPortada(recurso),
      },
    });
  } catch (error) {
    console.error('Error POST /publicaciones/medios/video-verificar:', errorDeCloudinary(error));
    res.status(500).json({ success: false, message: 'Error al verificar el video' });
  }
});

// ══════════════════════════════════════
// COMENTARIOS POR ID (ocultar y volver a mostrar)
// ══════════════════════════════════════

// ── Ocultar o volver a mostrar (personal) ──
router.put('/comentarios/:id', SOLO_PERSONAL, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comentario no encontrado' });
  const oculto = req.body?.oculto;
  if (typeof oculto !== 'boolean') return rechazar(res, ['Oculto: debe ser verdadero o falso']);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query(`${SQL_COMENTARIOS} WHERE c.id = $1 FOR UPDATE OF c`, [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comentario no encontrado' });
    }
    const actual = rows[0];
    if (actual.oculto === oculto) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        comentario: comentarioAdminDeFila(actual, req.usuario),
        message: oculto ? 'El comentario ya estaba oculto' : 'El comentario ya estaba visible',
      });
    }
    // Lo que un cliente borró por su cuenta no lo vuelve a publicar nadie más
    if (!oculto && actual.oculto_motivo === 'autor' && actual.usuario_id !== req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Este comentario lo borró su autor y no se puede volver a mostrar' });
    }
    if (oculto) {
      await client.query(
        'UPDATE core.tblpublicacion_comentarios SET oculto = true, oculto_por = $2, oculto_motivo = $3 WHERE id = $1',
        [id, req.usuario.id, motivoOcultar(req.usuario, actual)]
      );
    } else {
      await client.query(
        'UPDATE core.tblpublicacion_comentarios SET oculto = false, oculto_por = NULL, oculto_motivo = NULL WHERE id = $1',
        [id]
      );
    }
    const { rows: [comentario] } = await client.query(`${SQL_COMENTARIOS} WHERE c.id = $1`, [id]);
    await client.query('COMMIT');

    registrarAuditoria({
      usuario_id: req.usuario.id, accion: oculto ? 'Ocultó comentario' : 'Volvió a mostrar comentario',
      entidad: 'comentario', entidad_id: id, detalles: detalleComentario(comentario), ip: req.ip,
    });

    res.json({
      success: true,
      comentario: comentarioAdminDeFila(comentario, req.usuario),
      message: oculto ? 'Comentario ocultado' : 'El comentario se volvió a mostrar',
    });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /publicaciones/comentarios/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar el comentario' });
  } finally {
    if (client) client.release();
  }
});

// ── Borrar: el cliente oculta el suyo; el personal oculta cualquiera (no se borra de la base) ──
router.delete('/comentarios/:id', PUEDE_LEER, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comentario no encontrado' });
  const personal = esPersonal(req.usuario);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query(`${SQL_COMENTARIOS} WHERE c.id = $1 FOR UPDATE OF c`, [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comentario no encontrado' });
    }
    const comentario = rows[0];
    const propio = comentario.usuario_id === req.usuario.id;
    if (!propio && !personal) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Solo puedes eliminar tus propios comentarios' });
    }
    if (comentario.oculto) {
      // Ya estaba oculto. Si lo ocultó el personal y ahora lo borra su autor, queda como borrado por
      // el autor: así nadie más lo vuelve a mostrar (PUT /comentarios/:id responde 409)
      if (propio && comentario.oculto_motivo !== 'autor') {
        await client.query(
          "UPDATE core.tblpublicacion_comentarios SET oculto_por = $2, oculto_motivo = 'autor' WHERE id = $1",
          [id, req.usuario.id]
        );
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
      return res.json({ success: true, message: 'El comentario ya no está visible' });
    }
    await client.query(
      'UPDATE core.tblpublicacion_comentarios SET oculto = true, oculto_por = $2, oculto_motivo = $3 WHERE id = $1',
      [id, req.usuario.id, motivoOcultar(req.usuario, comentario)]
    );
    await client.query('COMMIT');

    // A la bitácora va lo que hace el personal; que un cliente borre lo suyo no
    if (personal) {
      registrarAuditoria({
        usuario_id: req.usuario.id, accion: 'Ocultó comentario', entidad: 'comentario', entidad_id: id,
        detalles: detalleComentario(comentario), ip: req.ip,
      });
    }

    res.json({ success: true, message: propio ? 'Comentario eliminado' : 'Comentario ocultado' });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error DELETE /publicaciones/comentarios/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar el comentario' });
  } finally {
    if (client) client.release();
  }
});

// ══════════════════════════════════════
// PUBLICACIONES (personal)
// ══════════════════════════════════════

// ── Lista con métricas (publicadas o eliminadas) ──
router.get('/', SOLO_PERSONAL, async (req, res) => {
  const estado = req.query.estado === undefined ? 'publicada' : req.query.estado;
  if (estado !== 'publicada' && estado !== 'eliminada') {
    return res.status(400).json({ success: false, message: 'Estado no válido. Valores: publicada, eliminada' });
  }
  try {
    res.json({ success: true, publicaciones: await leerPublicacionesAdmin(pool, { estado }) });
  } catch (error) {
    console.error('Error GET /publicaciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las publicaciones' });
  }
});

// ── Publicar en el inicio ──
router.post('/', SOLO_PERSONAL, async (req, res) => {
  const { errores, publicacion } = validarPublicacion(req.body, []);
  if (errores.length > 0) return rechazar(res, errores);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO core.tblpublicaciones (autor_id, texto) VALUES ($1, $2) RETURNING id, texto',
      [req.usuario.id, publicacion.texto]
    );
    const creada = rows[0];
    await insertarMedios(client, creada.id, publicacion.medios);
    // Se lee antes del COMMIT: si la lectura fallara después, respondería error de algo ya publicado
    const [guardada] = await leerPublicacionesAdmin(client, { id: creada.id });
    await client.query('COMMIT');

    registrarAuditoria({
      usuario_id: req.usuario.id, accion: 'Publicó en el inicio', entidad: 'publicacion', entidad_id: creada.id,
      detalles: resumenPublicacion(creada.texto, publicacion.medios), ip: req.ip,
    });

    res.status(201).json({ success: true, publicacion: guardada, message: 'Publicación creada' });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error POST /publicaciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al publicar' });
  } finally {
    if (client) client.release();
  }
});

// ── Editar texto y medios (queda marcada como editada) ──
router.put('/:id', SOLO_PERSONAL, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, estado, texto FROM core.tblpublicaciones WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return noEncontrada(res);
    }
    const actual = rows[0];
    if (actual.estado !== 'publicada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Esta publicación fue eliminada y ya no se puede modificar' });
    }
    const { rows: guardados } = await client.query(
      `SELECT tipo, url, public_id, ancho, alto, duracion, poster_url
       FROM core.tblpublicacion_medios WHERE publicacion_id = $1 ORDER BY orden, id`,
      [id]
    );
    const { errores, publicacion: nueva } = validarPublicacion(req.body, guardados);
    if (errores.length > 0) {
      await client.query('ROLLBACK');
      return rechazar(res, errores);
    }
    const cambianMedios = !mismosMedios(guardados, nueva.medios);
    if (actual.texto === nueva.texto && !cambianMedios) {
      // Sin cambios no se marca como editada
      const [guardada] = await leerPublicacionesAdmin(client, { id });
      await client.query('ROLLBACK');
      return res.json({ success: true, publicacion: guardada, message: 'No hubo cambios' });
    }
    const { rows: [editada] } = await client.query(
      'UPDATE core.tblpublicaciones SET texto = $2, editada = true WHERE id = $1 RETURNING texto',
      [id, nueva.texto]
    );
    if (cambianMedios) {
      await client.query('DELETE FROM core.tblpublicacion_medios WHERE publicacion_id = $1', [id]);
      await insertarMedios(client, id, nueva.medios);
    }
    // Se lee antes del COMMIT, como al publicar
    const [guardada] = await leerPublicacionesAdmin(client, { id });
    await client.query('COMMIT');

    registrarAuditoria({
      usuario_id: req.usuario.id, accion: 'Editó publicación', entidad: 'publicacion', entidad_id: id,
      detalles: resumenPublicacion(editada.texto, nueva.medios), ip: req.ip,
    });

    res.json({ success: true, publicacion: guardada, message: 'Publicación actualizada' });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /publicaciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar la publicación' });
  } finally {
    if (client) client.release();
  }
});

// ── Eliminar: sale del feed pero no se borra (conserva corazones y comentarios) ──
router.delete('/:id', SOLO_PERSONAL, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, estado FROM core.tblpublicaciones WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return noEncontrada(res);
    }
    if (rows[0].estado !== 'publicada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Esta publicación ya fue eliminada' });
    }
    const { rows: [eliminada] } = await client.query(
      "UPDATE core.tblpublicaciones SET estado = 'eliminada' WHERE id = $1 RETURNING texto",
      [id]
    );
    const medios = await client.query('SELECT tipo FROM core.tblpublicacion_medios WHERE publicacion_id = $1', [id]);
    await client.query('COMMIT');

    registrarAuditoria({
      usuario_id: req.usuario.id, accion: 'Eliminó publicación', entidad: 'publicacion', entidad_id: id,
      detalles: resumenPublicacion(eliminada.texto, medios.rows), ip: req.ip,
    });

    res.json({ success: true, message: 'Publicación eliminada' });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error DELETE /publicaciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar la publicación' });
  } finally {
    if (client) client.release();
  }
});

// ══════════════════════════════════════
// "ME ENCANTA" (solo clientes)
// ══════════════════════════════════════

/** Pone o quita el corazón del cliente y devuelve el conteo exacto (RespuestaCorazon) */
async function cambiarCorazon(req, res, poner) {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // FOR SHARE: muchos clientes a la vez, pero nadie la elimina a media reacción
    const { rows } = await client.query(
      "SELECT id FROM core.tblpublicaciones WHERE id = $1 AND estado = 'publicada' FOR SHARE",
      [id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return noEncontrada(res);
    }
    // Idempotente: la llave primaria (publicación, usuario) hace que dos toques cuenten uno
    await client.query(
      poner
        ? 'INSERT INTO core.tblpublicacion_reacciones (publicacion_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
        : 'DELETE FROM core.tblpublicacion_reacciones WHERE publicacion_id = $1 AND usuario_id = $2',
      [id, req.usuario.id]
    );
    // Conteo en otra sentencia: su lectura ya incluye el toque simultáneo que ON CONFLICT esperó
    const { rows: [conteo] } = await client.query(
      `SELECT COUNT(*)::int AS corazones, COALESCE(bool_or(usuario_id = $2), false) AS me_encanta
       FROM core.tblpublicacion_reacciones WHERE publicacion_id = $1`,
      [id, req.usuario.id]
    );
    await client.query('COMMIT');
    return res.json({ success: true, me_encanta: conteo.me_encanta, corazones: conteo.corazones });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error en el corazón de una publicación:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo guardar tu reacción' });
  } finally {
    if (client) client.release();
  }
}

router.put('/:id/corazon', SOLO_CLIENTE, (req, res) => cambiarCorazon(req, res, true));
router.delete('/:id/corazon', SOLO_CLIENTE, (req, res) => cambiarCorazon(req, res, false));

// ══════════════════════════════════════
// COMENTARIOS DE UNA PUBLICACIÓN
// ══════════════════════════════════════

// ── Todos, ocultos incluidos con quién y por qué (personal) ──
router.get('/:id/comentarios/todos', SOLO_PERSONAL, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  try {
    const [publicacionR, comentariosR] = await Promise.all([
      pool.query('SELECT id FROM core.tblpublicaciones WHERE id = $1', [id]),
      pool.query(`${SQL_COMENTARIOS} WHERE c.publicacion_id = $1 ORDER BY c.created_at, c.id`, [id]),
    ]);
    if (publicacionR.rows.length === 0) return noEncontrada(res);
    res.json({ success: true, comentarios: comentariosR.rows.map((f) => comentarioAdminDeFila(f, req.usuario)) });
  } catch (error) {
    console.error('Error GET /publicaciones/:id/comentarios/todos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener los comentarios' });
  }
});

// ── Visibles, en orden cronológico y por páginas (después del comentario despues_id) ──
router.get('/:id/comentarios', PUEDE_LEER, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  const despuesId = req.query.despues_id === undefined ? null : idDe(req.query.despues_id);
  if (req.query.despues_id !== undefined && !despuesId) {
    return res.status(400).json({ success: false, message: 'No se pudieron cargar más comentarios. Recarga la página.' });
  }
  const limite = enteroEntre(req.query.limite, 1, 50, 20);
  try {
    const { rows: [revision] } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM core.tblpublicaciones WHERE id = $1 AND estado = 'publicada') AS publicada,
              ($2::int IS NULL OR EXISTS (
                SELECT 1 FROM core.tblpublicacion_comentarios WHERE id = $2::int AND publicacion_id = $1)) AS referencia`,
      [id, despuesId]
    );
    if (!revision.publicada) return noEncontrada(res);
    if (!revision.referencia) {
      return res.status(400).json({ success: false, message: 'No se pudieron cargar más comentarios. Recarga la página.' });
    }
    // La posición se compara en la base: (created_at, id) conserva los microsegundos
    const { rows } = await pool.query(
      `${SQL_COMENTARIOS}
       WHERE c.publicacion_id = $1 AND NOT c.oculto
         AND ($2::int IS NULL OR (c.created_at, c.id) > (
           SELECT r.created_at, r.id FROM core.tblpublicacion_comentarios r WHERE r.id = $2::int))
       ORDER BY c.created_at, c.id
       LIMIT $3::int`,
      [id, despuesId, limite + 1]
    );
    res.json({
      success: true,
      comentarios: rows.slice(0, limite).map((f) => comentarioDeFila(f, req.usuario)),
      hay_mas: rows.length > limite,
    });
  } catch (error) {
    console.error('Error GET /publicaciones/:id/comentarios:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener los comentarios' });
  }
});

// Antispam: comentarios por persona en el último minuto
const MAX_COMENTARIOS_POR_MINUTO = 5;

// ── Comentar: el cliente comenta normal; el personal responde como Pier Repostería ──
router.post('/:id/comentarios', PUEDE_LEER, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return noEncontrada(res);
  const errores = [];
  const texto = limpiarTexto(req.body?.texto, 'Comentario', MAX_TEXTO_COMENTARIO, errores, { min: 1, colapsar: true });
  if (errores.length > 0) return rechazar(res, errores);
  const oficial = esPersonal(req.usuario);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: publicada } = await client.query(
      "SELECT id FROM core.tblpublicaciones WHERE id = $1 AND estado = 'publicada' FOR SHARE",
      [id]
    );
    if (publicada.length === 0) {
      await client.query('ROLLBACK');
      return noEncontrada(res);
    }
    // Los comentarios de una misma persona se cuentan en fila (candado por usuario hasta el
    // COMMIT): dos envíos simultáneos no pueden colarse los dos con el cuarto comentario
    await client.query("SELECT pg_advisory_xact_lock(hashtext('feed:comentarios'), $1::int)", [req.usuario.id]);
    const { rows: [ventana] } = await client.query(
      `SELECT COUNT(*)::int AS recientes FROM core.tblpublicacion_comentarios
       WHERE usuario_id = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
      [req.usuario.id]
    );
    if (ventana.recientes >= MAX_COMENTARIOS_POR_MINUTO) {
      await client.query('ROLLBACK');
      return res.status(429).json({
        success: false,
        message: 'Escribiste varios comentarios seguidos. Espera un minuto y vuelve a intentarlo.',
      });
    }
    const { rows: [comentario] } = await client.query(
      `WITH nuevo AS (
         INSERT INTO core.tblpublicacion_comentarios (publicacion_id, usuario_id, texto, es_oficial)
         VALUES ($1, $2, $3, $4)
         RETURNING id, publicacion_id, usuario_id, texto, es_oficial, created_at
       )
       SELECT n.*, u.nombre, u.apellido, u.avatar_url FROM nuevo n JOIN core.tblusuarios u ON u.id = n.usuario_id`,
      [id, req.usuario.id, texto, oficial]
    );
    await client.query('COMMIT');

    if (oficial) {
      registrarAuditoria({
        usuario_id: req.usuario.id, accion: 'Respondió comentario', entidad: 'comentario', entidad_id: comentario.id,
        detalles: `Publicación #${id} · ${recortar(comentario.texto, 80)}`, ip: req.ip,
      });
    }

    res.status(201).json({ success: true, comentario: comentarioDeFila(comentario, req.usuario) });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error POST /publicaciones/:id/comentarios:', error.message);
    res.status(500).json({ success: false, message: 'Error al publicar tu comentario' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
