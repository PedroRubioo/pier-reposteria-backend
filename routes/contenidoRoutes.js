// routes/contenidoRoutes.js — Editor del sitio (/api/contenido)
//
// Contenido del sitio público que Dirección general cambia viendo la página
// real: lectura pública de todo lo publicado, publicación de varios bloques
// en una sola transacción y subida de fotos a Cloudinary. El contrato
// completo está en Diseno_Editor_Sitio.md (§2); el catálogo de bloques y las
// reglas puras, en utils/contenidoSitio.js. Está exento del sanitizador
// global (middleware/validation.js): aquí se valida campo por campo, el SQL
// es parametrizado y React escapa al pintar, así que los textos se guardan
// tal cual.
const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { cargarUsuarioVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  MAX_BLOQUES, IDS_LECTURA, esObjeto, jsonOrdenado, armarContenido, validarBloques, resumenErrores,
} = require('../utils/contenidoSitio');

// ══════════════════════════════════════
// PERMISOS
// ══════════════════════════════════════

// Publicar y subir fotos: solo Dirección general, con el rol leído de la
// base en cada petición (no el que quedó dentro del JWT)
const SOLO_DIRECCION = [
  verifyToken,
  cargarUsuarioVigente,
  (req, res, next) => (req.usuario.rol === 'direccion_general'
    ? next()
    : res.status(403).json({ success: false, message: 'Solo Dirección general puede editar el sitio' })),
];

// ══════════════════════════════════════
// AUXILIARES
// ══════════════════════════════════════

/** Lo publicado, como lo devuelve GET; `db` es el pool o el cliente de una transacción */
async function leerContenido(db) {
  const { rows } = await db.query(
    `SELECT seccion, clave, valor, updated_at FROM core.tblconfiguracion_sistema
     WHERE (seccion || '.' || clave) = ANY($1::text[])`,
    [IDS_LECTURA]
  );
  return armarContenido(rows);
}

/** En el catch: si la conexión se cayó, ROLLBACK también falla y no debe tapar el error original */
async function deshacer(client) {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    console.error('ROLLBACK del contenido del sitio falló:', error.message);
  }
}

// ══════════════════════════════════════
// FOTOS (Cloudinary)
// ══════════════════════════════════════

// Misma configuración que routes/uploadRoutes.js, comandas y el feed
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const CLOUDINARY_LISTO = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

const CARPETA_SITIO = 'pier-reposteria/sitio';
const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

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
      return res.status(400).json({ success: false, message: 'Solo se aceptan imágenes JPG, PNG, WebP o HEIC' });
    }
    return res.status(400).json({ success: false, message: 'No se pudo leer la imagen: envíala en el campo "imagen"' });
  });
}

const exigirCloudinary = (req, res, next) => (CLOUDINARY_LISTO
  ? next()
  : res.status(503).json({ success: false, message: 'La subida de fotos no está configurada (Cloudinary)' }));

/** Foto del sitio: hasta 2000 px por lado, calidad automática y en webp */
function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const destino = cloudinary.uploader.upload_stream(
      {
        folder: CARPETA_SITIO,
        transformation: [{ width: 2000, height: 2000, crop: 'limit', quality: 'auto', format: 'webp' }],
      },
      (error, resultado) => (error ? reject(error) : resolve(resultado))
    );
    streamifier.createReadStream(buffer).pipe(destino);
  });
}

/** Cloudinary rechaza con { error: { message, http_code } } o con un Error de red */
const errorDeCloudinary = (error) => error?.error?.message ?? error?.message ?? String(error);

// ══════════════════════════════════════
// RUTAS
// ══════════════════════════════════════

// ── Todo lo publicado (público, sin sesión) ──
// Solo bloques del catálogo que existen en la base y cumplen su esquema; lo
// que falte lo pone el frontend con su valor por defecto
router.get('/', async (req, res) => {
  try {
    const { contenido, actualizado } = await leerContenido(pool);
    res.set('Cache-Control', 'no-cache');
    res.json({ success: true, contenido, actualizado });
  } catch (error) {
    console.error('Error GET /contenido:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el contenido del sitio' });
  }
});

// ── Publicar cambios: { bloques: { [bloque]: valor } } (1–30) ──
router.put('/', SOLO_DIRECCION, async (req, res) => {
  const bloques = esObjeto(req.body) ? req.body.bloques : undefined;
  const cantidad = esObjeto(bloques) ? Object.keys(bloques).length : 0;
  if (cantidad < 1 || cantidad > MAX_BLOQUES) {
    return res.status(400).json({ success: false, message: `Envía de 1 a ${MAX_BLOQUES} bloques en "bloques"`, errores: [] });
  }
  // Se valida TODO antes de escribir: con un solo error no se guarda nada
  const { validos, errores } = validarBloques(bloques);
  if (errores.length > 0) {
    return res.status(400).json({ success: false, message: resumenErrores(errores), errores });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Las filas que ya existen se bloquean: se compara contra lo último guardado
    const { rows } = await client.query(
      `SELECT seccion, clave, valor FROM core.tblconfiguracion_sistema
       WHERE (seccion || '.' || clave) = ANY($1::text[])
       FOR UPDATE`,
      [validos.map((b) => b.id)]
    );
    const anteriores = new Map(rows.map((f) => [`${f.seccion}.${f.clave}`, jsonOrdenado(f.valor)]));
    // Solo se escribe lo que realmente cambió: un bloque igual no mueve su
    // fecha (la "Última actualización" de Legales) ni deja fila en la bitácora
    const cambiados = validos.filter((b) => anteriores.get(b.id) !== jsonOrdenado(b.valor));
    for (const b of cambiados) {
      await client.query(
        `INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_at, updated_by)
         VALUES ($1, $2, $3::jsonb, NOW(), $4)
         ON CONFLICT (seccion, clave) DO UPDATE
           SET valor = EXCLUDED.valor, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [b.seccion, b.clave, JSON.stringify(b.valor), req.usuario.id]
      );
    }
    // La app Flutter titula su carrusel con inicio.hero: sigue a la primera
    // diapositiva del carrusel que se publica aquí
    const carrusel = cambiados.find((b) => b.id === 'inicio.carrusel');
    if (carrusel) {
      const [primera] = carrusel.valor;
      await client.query(
        `INSERT INTO core.tblconfiguracion_sistema AS c (seccion, clave, valor, updated_at, updated_by)
         VALUES ('inicio', 'hero', $1::jsonb, NOW(), $2)
         ON CONFLICT (seccion, clave) DO UPDATE
           SET valor = EXCLUDED.valor, updated_at = NOW(), updated_by = EXCLUDED.updated_by
           WHERE c.valor IS DISTINCT FROM EXCLUDED.valor`,
        [JSON.stringify({ titulo: primera.titulo, subtitulo: primera.subtitulo }), req.usuario.id]
      );
    }
    // Releído dentro de la transacción: la respuesta trae justo lo que quedó
    const { contenido, actualizado } = await leerContenido(client);
    await client.query('COMMIT');

    // Bitácora después del COMMIT: una fila por bloque que cambió
    await Promise.all(cambiados.map((b) => registrarAuditoria({
      usuario_id: req.usuario.id,
      accion: 'Editó contenido del sitio',
      entidad: 'contenido',
      entidad_id: null,
      detalles: `${b.pagina} · ${b.etiqueta}`,
      ip: req.ip,
    })));
    res.set('Cache-Control', 'no-cache');
    return res.json({ success: true, message: 'Cambios publicados', contenido, actualizado });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /contenido:', error.message);
    return res.status(500).json({ success: false, message: 'Error al publicar los cambios; no se guardó nada' });
  } finally {
    if (client) client.release();
  }
});

// ── Subir una foto (2000 px en webp, carpeta del sitio) ──
router.post('/imagen', SOLO_DIRECCION, exigirCloudinary, recibirImagen, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se envió ninguna imagen' });
  try {
    const resultado = await subirACloudinary(req.file.buffer);
    return res.status(201).json({
      success: true,
      imagen: { url: resultado.secure_url, public_id: resultado.public_id, ancho: resultado.width, alto: resultado.height },
    });
  } catch (error) {
    console.error('Error POST /contenido/imagen:', errorDeCloudinary(error));
    return res.status(500).json({ success: false, message: 'Error al subir la imagen' });
  }
});

module.exports = router;
