// routes/comandasRoutes.js — Comandas de pedidos tomados en la sucursal
//
// Módulo interno (ningún cliente lo ve) que sustituye el Excel, la
// bitácora en papel y la nota de remisión: captura, agenda con semáforo,
// "Enterado" de hornos y decoración ligado a la versión que leyeron y
// re-firma cuando cambia algo de producción. El contrato completo está en
// Diseno_Modulo_Comandas.md (§4); las reglas puras, en utils/comandas.js.
const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');
const { notificarRoles } = require('../services/notificacionHelper');
const {
  TIPOS_OPCION, TIPO_LEGIBLE, AREA_LEGIBLE, esId, aNumero, aCentavos, moneda, decimal,
  fechaLarga, horaLegible, recortar, normalizarAjustes, validarAjustes, semaforo, resumenRenglones,
  comandaDeFilas, texto, claveOpcion, validarComanda, snapshotProduccion, diffProduccion, diffAdministrativo, textoCambio,
} = require('../utils/comandas');

// ══════════════════════════════════════
// PERMISOS (§4.2)
// ══════════════════════════════════════

const CAPTURA = ['empleado', 'gerencia', 'direccion_general'];
const PRODUCCION = ['hornos', 'decoracion'];
const SUPERVISION = ['gerencia', 'direccion_general'];
const VER = [...CAPTURA, ...PRODUCCION];

/**
 * Relee al usuario en cada petición: vale el rol de la base, no el del JWT.
 * Los tokens duran 7 días; sin esto, alguien desactivado o cambiado de rol
 * podría seguir firmando o editando con su token viejo.
 */
async function cargarUsuarioVigente(req, res, next) {
  try {
    const id = Number(req.user.userId);
    const { rows } = esId(id)
      ? await pool.query('SELECT id, rol::text AS rol, activo, nombre, apellido FROM core.tblusuarios WHERE id = $1', [id])
      : { rows: [] };
    const usuario = rows[0];
    if (!usuario || !usuario.activo) {
      return res.status(401).json({
        success: false,
        codigo: 'SESION_INVALIDA',
        message: 'Tu cuenta está desactivada o cambió. Inicia sesión de nuevo.',
      });
    }
    req.usuario = { id: usuario.id, rol: usuario.rol, nombre: `${usuario.nombre} ${usuario.apellido}` };
    return next();
  } catch (error) {
    console.error('Error verificando usuario de comandas:', error.message);
    return res.status(500).json({ success: false, message: 'Error al verificar tu sesión' });
  }
}

function exigirRol(roles) {
  return (req, res, next) => (roles.includes(req.usuario.rol)
    ? next()
    : res.status(403).json({ success: false, message: 'No tienes permiso para esta acción' }));
}

const acceso = (roles) => [verifyToken, cargarUsuarioVigente, exigirRol(roles)];
const PUEDE_VER = acceso(VER);
const PUEDE_CAPTURAR = acceso(CAPTURA);
const SOLO_PRODUCCION = acceso(PRODUCCION);
const SOLO_SUPERVISION = acceso(SUPERVISION);

/** Editar y cancelar: quien tomó el pedido, o gerencia y dirección. Producción jamás edita */
const esEditor = (usuario, comanda) => CAPTURA.includes(usuario.rol)
  && (comanda.tomado_por === usuario.id || SUPERVISION.includes(usuario.rol));

const soloEditores = (accion) => `Solo quien tomó la comanda, gerencia o dirección pueden ${accion}la`;

// ══════════════════════════════════════
// AUXILIARES
// ══════════════════════════════════════

/** Id de la URL como entero; null si no lo es (se responde 404) */
function idDe(valor) {
  const n = /^\d{1,10}$/.test(valor) ? Number(valor) : NaN;
  return esId(n) ? n : null;
}

/** "Hoy" del negocio en Huejutla (CURRENT_DATE es UTC: a las 18:00 ya sería mañana) y ajustes */
async function leerContexto(db) {
  const { rows } = await db.query(
    `SELECT to_char((NOW() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS hoy,
            (SELECT jsonb_object_agg(clave, valor) FROM core.tblconfiguracion_sistema WHERE seccion = 'comandas') AS ajustes`
  );
  return { hoy: rows[0].hoy, ajustes: normalizarAjustes(rows[0].ajustes) };
}

/** 400 con todos los problemas; message es el primero */
const rechazar = (res, errores) => res.status(400).json({ success: false, message: errores[0], errores });

const yaCerrada = (estado, accion) => `Esta comanda ya fue ${estado} y no se puede ${accion}`;

/** Aviso (no bloquea) cuando la entrega queda en menos días que la anticipación mínima */
function avisoAnticipacion(diasRestantes, ajustes) {
  const n = ajustes.dias_anticipacion_minima;
  return diasRestantes < n
    ? [`La entrega es en menos de ${n} ${n === 1 ? 'día' : 'días'}: confirma con producción que alcanza.`]
    : [];
}

/** En el catch: si la conexión se cayó, ROLLBACK también falla y no debe tapar el error original */
async function deshacer(client) {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    console.error('ROLLBACK de comandas falló:', error.message);
  }
}

/** Firma de un área respecto a la versión vigente (FirmaArea) */
function firmaArea(version, usuarioNombre, fecha, versionActual) {
  return { vigente: version !== null && version === versionActual, version, usuario_nombre: usuarioNombre, fecha };
}

/** Columnas editables de la cabecera, en el orden de los INSERT/UPDATE */
const valoresCabecera = (c) => [
  c.cliente_nombre, c.cliente_telefono, c.fecha_entrega, c.hora_entrega, c.notas,
  c.mesa_color_capacillos, c.mesa_color_betun, c.mesa_color_grageas,
  decimal(c.descuento_centavos), decimal(c.total_centavos), decimal(c.anticipo_centavos),
];

/** Todos los renglones en un solo INSERT (jsonb_to_recordset): una ida a la base y no hasta 30 */
async function insertarRenglones(client, comandaId, items) {
  const filas = items.map((r, i) => ({
    orden: i + 1, tipo: r.tipo, producto_id: r.producto_id, nombre: r.nombre,
    tamano_catalogo: r.tamano_catalogo, indicaciones: r.indicaciones,
    sabor: r.sabor, tamano: r.tamano, forma: r.forma, num_pisos: r.num_pisos, decoracion: r.decoracion,
    color_fondo: r.color_fondo, leyenda: r.leyenda, descripcion: r.descripcion, insumos: r.insumos,
    cantidad: r.cantidad, precio_unitario: decimal(r.precio_centavos), subtotal: decimal(r.cantidad * r.precio_centavos),
  }));
  await client.query(
    `INSERT INTO core.tblcomanda_items
       (comanda_id, orden, tipo, producto_id, nombre, tamano_catalogo, indicaciones, sabor, tamano, forma,
        num_pisos, decoracion, color_fondo, leyenda, descripcion, insumos, cantidad, precio_unitario, subtotal)
     SELECT $1, r.orden, r.tipo, r.producto_id, r.nombre, r.tamano_catalogo, r.indicaciones, r.sabor, r.tamano, r.forma,
            r.num_pisos, r.decoracion, r.color_fondo, r.leyenda, r.descripcion, r.insumos, r.cantidad, r.precio_unitario, r.subtotal
     FROM jsonb_to_recordset($2::jsonb) AS r(
       orden smallint, tipo text, producto_id integer, nombre text, tamano_catalogo text, indicaciones text,
       sabor text, tamano text, forma text, num_pisos smallint, decoracion text, color_fondo text, leyenda text,
       descripcion text, insumos text, cantidad integer, precio_unitario numeric, subtotal numeric)`,
    [comandaId, JSON.stringify(filas)]
  );
}

async function insertarImagenes(client, comandaId, imagenes) {
  if (imagenes.length === 0) return;
  await client.query(
    `INSERT INTO core.tblcomanda_imagenes (comanda_id, url, public_id, orden)
     SELECT $1, r.url, r.public_id, r.orden
     FROM jsonb_to_recordset($2::jsonb) AS r(url text, public_id text, orden smallint)`,
    [comandaId, JSON.stringify(imagenes.map((im, i) => ({ url: im.url, public_id: im.public_id, orden: i + 1 })))]
  );
}

/** Cabecera bloqueada (FOR UPDATE) y la comanda con la forma de validarComanda */
async function leerParaEditar(client, id) {
  const { rows } = await client.query(
    `SELECT id, folio, estado, version, tomado_por, updated_at, cliente_nombre, cliente_telefono,
            to_char(fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega, to_char(hora_entrega, 'HH24:MI') AS hora_entrega,
            notas, mesa_color_capacillos, mesa_color_betun, mesa_color_grageas, descuento, anticipo
     FROM core.tblcomandas WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (rows.length === 0) return null;
  const renglones = await client.query(
    `SELECT tipo, nombre, cantidad, precio_unitario, producto_id, tamano_catalogo, indicaciones, sabor, tamano, forma,
            num_pisos, decoracion, color_fondo, leyenda, descripcion, insumos
     FROM core.tblcomanda_items WHERE comanda_id = $1 ORDER BY orden`,
    [id]
  );
  const imagenes = await client.query(
    'SELECT url, public_id FROM core.tblcomanda_imagenes WHERE comanda_id = $1 ORDER BY orden',
    [id]
  );
  return { cabecera: rows[0], comanda: comandaDeFilas(rows[0], renglones.rows, imagenes.rows) };
}

/** Fila de la agenda → ResumenComanda */
function resumenDeFila(f, ajustes) {
  return {
    id: f.id,
    folio: f.folio,
    estado: f.estado,
    cliente_nombre: f.cliente_nombre,
    cliente_telefono: f.cliente_telefono,
    fecha_entrega: f.fecha_entrega,
    hora_entrega: f.hora_entrega,
    dias_restantes: f.dias_restantes,
    semaforo: semaforo(f.estado, f.dias_restantes, ajustes),
    version: f.version,
    resumen: resumenRenglones(f.renglones),
    num_productos: f.num_productos,
    tiene_pastel: f.tiene_pastel,
    num_imagenes: f.num_imagenes,
    total: f.total,
    anticipo: f.anticipo,
    saldo: f.saldo,
    tomado_por: { id: f.tomado_por, nombre: f.tomado_por_nombre },
    firmas: {
      hornos: firmaArea(f.hornos_version, f.hornos_usuario, f.hornos_fecha, f.version),
      decoracion: firmaArea(f.decoracion_version, f.decoracion_usuario, f.decoracion_fecha, f.version),
    },
    created_at: f.created_at,
    entregada_at: f.entregada_at,
    cancelada_at: f.cancelada_at,
  };
}

/** Renglón guardado → ItemPastel | ItemProducto (cada uno solo con sus campos) */
function renglonRespuesta(f) {
  const comunes = { id: f.id, tipo: f.tipo, orden: f.orden, nombre: f.nombre, cantidad: f.cantidad };
  if (f.tipo === 'pastel') {
    return {
      ...comunes,
      sabor: f.sabor, tamano: f.tamano, forma: f.forma, num_pisos: f.num_pisos, decoracion: f.decoracion,
      color_fondo: f.color_fondo, leyenda: f.leyenda, descripcion: f.descripcion, insumos: f.insumos,
      precio_unitario: f.precio_unitario, subtotal: f.subtotal,
    };
  }
  return {
    ...comunes,
    producto_id: f.producto_id, categoria: f.categoria, imagen_url: f.imagen_url,
    tamano_catalogo: f.tamano_catalogo, indicaciones: f.indicaciones,
    precio_unitario: f.precio_unitario, subtotal: f.subtotal,
  };
}

// ══════════════════════════════════════
// IMÁGENES DE REFERENCIA (Cloudinary)
// ══════════════════════════════════════

// Misma configuración que routes/uploadRoutes.js
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
  : res.status(503).json({ success: false, message: 'La subida de imágenes no está configurada (Cloudinary)' }));

function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const destino = cloudinary.uploader.upload_stream(
      {
        folder: 'pier-reposteria/comandas',
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto', format: 'webp' }],
      },
      (error, resultado) => (error ? reject(error) : resolve(resultado))
    );
    streamifier.createReadStream(buffer).pipe(destino);
  });
}

// ══════════════════════════════════════
// RUTAS ESPECÍFICAS (antes que /:id)
// ══════════════════════════════════════

// ── Catálogo para el formulario y la agenda ──
router.get('/catalogo', PUEDE_VER, async (req, res) => {
  try {
    // Producción no captura: no necesita los productos del catálogo
    const conProductos = CAPTURA.includes(req.usuario.rol);
    const [opcionesR, contexto, productosR] = await Promise.all([
      pool.query('SELECT id, tipo, nombre, orden FROM core.tblcomanda_opciones WHERE activo ORDER BY orden, nombre'),
      leerContexto(pool),
      conProductos
        ? pool.query(
          `SELECT p.id, p.nombre, c.nombre AS categoria, p.precio_chico, p.precio_grande, p.imagen_url
           FROM core.tblproductos p JOIN core.tblcategorias c ON c.id = p.categoria_id
           WHERE p.activo AND c.activo
           ORDER BY c.orden, c.nombre, p.nombre`
        )
        : null,
    ]);
    const opciones = new Map(TIPOS_OPCION.map((tipo) => [tipo, []]));
    for (const o of opcionesR.rows) opciones.get(o.tipo).push({ id: o.id, nombre: o.nombre, orden: o.orden });
    res.json({
      success: true,
      opciones: Object.fromEntries(opciones),
      ajustes: contexto.ajustes,
      productos: productosR ? productosR.rows : [],
    });
  } catch (error) {
    console.error('Error GET /comandas/catalogo:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el catálogo de comandas' });
  }
});

// ── Opciones: todas, activas e inactivas (gerencia y dirección) ──
router.get('/opciones', SOLO_SUPERVISION, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, tipo, nombre, orden, activo FROM core.tblcomanda_opciones ORDER BY tipo, activo DESC, orden, nombre'
    );
    res.json({ success: true, opciones: rows });
  } catch (error) {
    console.error('Error GET /comandas/opciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las opciones' });
  }
});

/**
 * Altas y cambios de opciones van de uno en uno. El nombre repetido (sin
 * distinguir mayúsculas, §4.3) se busca en JS con claveOpcion, la misma
 * clave con que se capturan los pasteles: LOWER() depende del locale de la
 * base (con 'C' no pliega Ñ ni vocales acentuadas) y ni la consulta ni el
 * índice uq_comanda_opcion_activa lo detectarían. SHARE ROW EXCLUSIVE choca
 * consigo mismo y con INSERT/UPDATE, no con las lecturas: el catálogo y la
 * captura de comandas no esperan.
 */
const bloquearOpciones = (client) => client.query('LOCK TABLE core.tblcomanda_opciones IN SHARE ROW EXCLUSIVE MODE');

// ── Agregar opción (o reactivar la inactiva con el mismo nombre) ──
router.post('/opciones', SOLO_SUPERVISION, async (req, res) => {
  const errores = [];
  const tipo = req.body?.tipo;
  if (!TIPOS_OPCION.includes(tipo)) errores.push('Tipo: elige tamaño, sabor, forma o decoración');
  const nombre = texto(req.body?.nombre, 'Nombre', 80, errores, { min: 1, unaLinea: true });
  if (errores.length > 0) return rechazar(res, errores);
  const duplicada = `"${nombre}" ya existe como opción de ${TIPO_LEGIBLE.get(tipo)}`;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await bloquearOpciones(client);
    const { rows: delTipo } = await client.query(
      'SELECT id, nombre, activo FROM core.tblcomanda_opciones WHERE tipo = $1 ORDER BY activo DESC, id DESC',
      [tipo]
    );
    // La activa con ese nombre primero; si no hay, la inactiva más reciente
    const existente = delTipo.find((o) => claveOpcion(o.nombre) === claveOpcion(nombre));
    if (existente?.activo) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: duplicada });
    }
    // Reactivar en lugar de duplicar conserva el id y el orden que tenía
    const { rows } = existente
      ? await client.query(
        'UPDATE core.tblcomanda_opciones SET activo = true WHERE id = $1 RETURNING id, tipo, nombre, orden, activo',
        [existente.id]
      )
      : await client.query(
        `INSERT INTO core.tblcomanda_opciones (tipo, nombre, orden)
         SELECT $1::text, $2::text, COALESCE(MAX(orden), 0) + 1 FROM core.tblcomanda_opciones WHERE tipo = $1::text
         RETURNING id, tipo, nombre, orden, activo`,
        [tipo, nombre]
      );
    await client.query('COMMIT');
    const opcion = rows[0];
    return res.status(201).json({
      success: true,
      opcion,
      message: existente ? `Se reactivó "${opcion.nombre}"` : `Se agregó "${opcion.nombre}"`,
    });
  } catch (error) {
    if (client) await deshacer(client);
    // Respaldo: el índice único sigue atajando lo que LOWER() sí pliega
    if (error.code === '23505') return res.status(409).json({ success: false, message: duplicada });
    console.error('Error POST /comandas/opciones:', error.message);
    return res.status(500).json({ success: false, message: 'Error al agregar la opción' });
  } finally {
    if (client) client.release();
  }
});

/**
 * Cambia una opción sin dejar un tipo sin opciones activas (el formulario
 * ya no podría capturar pasteles) ni con dos activas del mismo nombre. Con
 * la tabla bloqueada (bloquearOpciones), dos desactivaciones simultáneas no
 * vacían el tipo y un renombre no choca con un alta en paralelo.
 */
async function modificarOpcion(req, res, cambios, mensaje) {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Opción no encontrada' });
  const nombreOcupado = 'Ya hay otra opción activa con ese nombre en este tipo';
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await bloquearOpciones(client);
    const { rows: delTipo } = await client.query(
      `SELECT id, tipo, nombre, activo FROM core.tblcomanda_opciones
       WHERE tipo = (SELECT tipo FROM core.tblcomanda_opciones WHERE id = $1) AND (activo OR id = $1)`,
      [id]
    );
    const opcion = delTipo.find((o) => o.id === id);
    if (!opcion) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Opción no encontrada' });
    }
    const otrasActivas = delTipo.filter((o) => o.activo && o.id !== id);
    if (cambios.activo === false && opcion.activo && otrasActivas.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Debe quedar al menos una opción de ${TIPO_LEGIBLE.get(opcion.tipo)}` });
    }
    // Renombrar o reactivar hacia un nombre que ya usa otra opción activa del tipo
    const clave = claveOpcion(cambios.nombre ?? opcion.nombre);
    if ((cambios.activo ?? opcion.activo) && otrasActivas.some((o) => claveOpcion(o.nombre) === clave)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: nombreOcupado });
    }
    // Renombrar no toca comandas viejas: guardan el texto, no una referencia
    const { rows } = await client.query(
      `UPDATE core.tblcomanda_opciones
       SET nombre = COALESCE($2, nombre), orden = COALESCE($3, orden), activo = COALESCE($4, activo)
       WHERE id = $1
       RETURNING id, tipo, nombre, orden, activo`,
      [id, cambios.nombre ?? null, cambios.orden ?? null, cambios.activo ?? null]
    );
    await client.query('COMMIT');
    return res.json({ success: true, opcion: rows[0], message: mensaje });
  } catch (error) {
    if (client) await deshacer(client);
    // Respaldo: el índice único sigue atajando lo que LOWER() sí pliega
    if (error.code === '23505') return res.status(409).json({ success: false, message: nombreOcupado });
    console.error('Error al modificar opción de comandas:', error.message);
    return res.status(500).json({ success: false, message: 'Error al guardar la opción' });
  } finally {
    if (client) client.release();
  }
}

// ── Renombrar, reordenar, activar o desactivar una opción ──
router.put('/opciones/:id', SOLO_SUPERVISION, (req, res) => {
  const cuerpo = req.body || {};
  const errores = [];
  const cambios = {};
  if (cuerpo.nombre !== undefined) cambios.nombre = texto(cuerpo.nombre, 'Nombre', 80, errores, { min: 1, unaLinea: true });
  if (cuerpo.orden !== undefined) {
    cambios.orden = aNumero(cuerpo.orden);
    if (!Number.isInteger(cambios.orden) || cambios.orden < 0 || cambios.orden > 100000) {
      errores.push('Orden: debe ser un entero de 0 a 100000');
    }
  }
  if (cuerpo.activo !== undefined) {
    if (typeof cuerpo.activo === 'boolean') cambios.activo = cuerpo.activo;
    else errores.push('Activo: debe ser verdadero o falso');
  }
  if (errores.length === 0 && Object.keys(cambios).length === 0) errores.push('Indica qué cambiar: nombre, orden o activo');
  if (errores.length > 0) return rechazar(res, errores);
  return modificarOpcion(req, res, cambios, 'Opción actualizada');
});

// ── Desactivar una opción (borrado lógico) ──
router.delete('/opciones/:id', SOLO_SUPERVISION, (req, res) => modificarOpcion(req, res, { activo: false }, 'Opción desactivada'));

// ── Ajustes: anticipo mínimo, anticipación y semáforo ──
router.put('/ajustes', SOLO_SUPERVISION, async (req, res) => {
  const { errores, ajustes } = validarAjustes(req.body);
  if (errores.length > 0) return rechazar(res, errores);
  try {
    // Upsert de las cinco claves en una sola sentencia (valores jsonb numéricos)
    await pool.query(
      `INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by)
       SELECT 'comandas', a.key, a.value, $2 FROM jsonb_each($1::jsonb) AS a
       ON CONFLICT (seccion, clave) DO UPDATE SET valor = EXCLUDED.valor, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(ajustes), req.usuario.id]
    );
    res.json({ success: true, ajustes, message: 'Ajustes guardados' });
  } catch (error) {
    console.error('Error PUT /comandas/ajustes:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar los ajustes' });
  }
});

// ── Subir una imagen de referencia ──
router.post('/imagenes', PUEDE_CAPTURAR, exigirCloudinary, recibirImagen, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se envió ninguna imagen' });
  try {
    // Nunca se borran de Cloudinary: el historial de versiones previas las sigue citando
    const resultado = await subirACloudinary(req.file.buffer);
    res.status(201).json({ success: true, imagen: { url: resultado.secure_url, public_id: resultado.public_id } });
  } catch (error) {
    console.error('Error POST /comandas/imagenes:', error.message);
    res.status(500).json({ success: false, message: 'Error al subir la imagen' });
  }
});

// ══════════════════════════════════════
// AGENDA Y DETALLE
// ══════════════════════════════════════

const VISTAS = new Map([['proximas', 'activa'], ['activas', 'activa'], ['entregadas', 'entregada'], ['canceladas', 'cancelada']]);

// ── Agenda: una sola consulta trae renglones, imágenes y firmas (sin N+1) ──
router.get('/', PUEDE_VER, async (req, res) => {
  const vista = req.query.vista === undefined ? 'proximas' : req.query.vista;
  const estado = VISTAS.get(vista);
  if (!estado) {
    return res.status(400).json({ success: false, message: 'Vista no válida. Valores: proximas, activas, entregadas, canceladas' });
  }
  let dias = null;
  if (vista === 'proximas') {
    const pedidos = Number.parseInt(req.query.dias, 10);
    dias = Number.isFinite(pedidos) ? Math.min(Math.max(pedidos, 1), 60) : 15;
  }
  const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda.trim().slice(0, 100) : '';
  // Folio exacto si es numérico; si no, parte del nombre del cliente con % y _ literales
  const folio = /^\d+$/.test(busqueda) ? busqueda.replace(/^0+(?=\d)/, '') : null;
  const patron = busqueda && folio === null ? `%${busqueda.replace(/[\\%_]/g, '\\$&')}%` : null;
  try {
    const { hoy, ajustes } = await leerContexto(pool);
    const { rows } = await pool.query(
      `SELECT c.id, c.folio, c.estado, c.cliente_nombre, c.cliente_telefono,
              to_char(c.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega,
              to_char(c.hora_entrega, 'HH24:MI') AS hora_entrega,
              (c.fecha_entrega - $1::date) AS dias_restantes,
              c.version, c.total, c.anticipo, (c.total - c.anticipo) AS saldo,
              c.tomado_por, t.nombre || ' ' || t.apellido AS tomado_por_nombre,
              c.created_at, c.entregada_at, c.cancelada_at,
              r.renglones, r.num_productos, r.tiene_pastel, im.num_imagenes,
              fh.version AS hornos_version, fh.usuario_nombre AS hornos_usuario, fh.created_at AS hornos_fecha,
              fd.version AS decoracion_version, fd.usuario_nombre AS decoracion_usuario, fd.created_at AS decoracion_fecha
       FROM core.tblcomandas c
       JOIN core.tblusuarios t ON t.id = c.tomado_por
       CROSS JOIN LATERAL (
         SELECT COALESCE(json_agg(json_build_object('tipo', i.tipo, 'nombre', i.nombre, 'cantidad', i.cantidad,
                                                    'tamano', i.tamano, 'tamano_catalogo', i.tamano_catalogo)
                                  ORDER BY i.orden), '[]') AS renglones,
                COALESCE(SUM(i.cantidad), 0)::int AS num_productos,
                COALESCE(bool_or(i.tipo = 'pastel'), false) AS tiene_pastel
         FROM core.tblcomanda_items i WHERE i.comanda_id = c.id
       ) r
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS num_imagenes FROM core.tblcomanda_imagenes x WHERE x.comanda_id = c.id
       ) im
       LEFT JOIN LATERAL (
         SELECT f.version, f.created_at, u.nombre || ' ' || u.apellido AS usuario_nombre
         FROM core.tblcomanda_confirmaciones f JOIN core.tblusuarios u ON u.id = f.usuario_id
         WHERE f.comanda_id = c.id AND f.area = 'hornos'
         ORDER BY f.version DESC LIMIT 1
       ) fh ON true
       LEFT JOIN LATERAL (
         SELECT f.version, f.created_at, u.nombre || ' ' || u.apellido AS usuario_nombre
         FROM core.tblcomanda_confirmaciones f JOIN core.tblusuarios u ON u.id = f.usuario_id
         WHERE f.comanda_id = c.id AND f.area = 'decoracion'
         ORDER BY f.version DESC LIMIT 1
       ) fd ON true
       WHERE c.estado = $2::text
         AND ($3::int IS NULL OR c.fecha_entrega <= $1::date + $3::int)
         AND ($4::text IS NULL OR c.folio::text = $4::text)
         AND ($5::text IS NULL OR c.cliente_nombre ILIKE $5::text)
       ORDER BY
         CASE WHEN $2::text = 'activa' THEN c.fecha_entrega END,
         CASE WHEN $2::text = 'activa' THEN c.hora_entrega END,
         CASE WHEN $2::text = 'activa' THEN c.folio END,
         CASE $2::text WHEN 'entregada' THEN c.entregada_at WHEN 'cancelada' THEN c.cancelada_at END DESC
       LIMIT $6::int`,
      // Activas: todas (las vencidas incluidas); entregadas y canceladas: las 200 más recientes
      [hoy, estado, dias, folio, patron, estado === 'activa' ? null : 200]
    );
    res.json({ success: true, hoy, ajustes, comandas: rows.map((f) => resumenDeFila(f, ajustes)) });
  } catch (error) {
    console.error('Error GET /comandas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las comandas' });
  }
});

// ── Detalle (DEBE ir DESPUÉS de las rutas específicas) ──
router.get('/:id', PUEDE_VER, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
  try {
    const { hoy, ajustes } = await leerContexto(pool);
    const [cabeceraR, renglonesR, imagenesR, confirmacionesR, historialR] = await Promise.all([
      pool.query(
        `SELECT c.id, c.folio, c.estado, c.sucursal, c.cliente_nombre, c.cliente_telefono,
                to_char(c.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega,
                to_char(c.hora_entrega, 'HH24:MI') AS hora_entrega,
                (c.fecha_entrega - $2::date) AS dias_restantes,
                c.notas, c.mesa_color_capacillos, c.mesa_color_betun, c.mesa_color_grageas,
                (c.total + c.descuento) AS subtotal, c.descuento, c.total, c.anticipo, (c.total - c.anticipo) AS saldo,
                c.version, c.updated_at, c.tomado_por, t.nombre || ' ' || t.apellido AS tomado_por_nombre, c.created_at,
                c.entregada_at, e.nombre || ' ' || e.apellido AS entregada_por_nombre, c.saldo_cobrado,
                c.cancelada_at, x.nombre || ' ' || x.apellido AS cancelada_por_nombre, c.motivo_cancelacion
         FROM core.tblcomandas c
         JOIN core.tblusuarios t ON t.id = c.tomado_por
         LEFT JOIN core.tblusuarios e ON e.id = c.entregada_por
         LEFT JOIN core.tblusuarios x ON x.id = c.cancelada_por
         WHERE c.id = $1`,
        [id, hoy]
      ),
      pool.query(
        `SELECT i.id, i.tipo, i.orden, i.nombre, i.cantidad, i.producto_id, ca.nombre AS categoria, p.imagen_url,
                i.tamano_catalogo, i.indicaciones, i.sabor, i.tamano, i.forma, i.num_pisos, i.decoracion,
                i.color_fondo, i.leyenda, i.descripcion, i.insumos, i.precio_unitario, i.subtotal
         FROM core.tblcomanda_items i
         LEFT JOIN core.tblproductos p ON p.id = i.producto_id
         LEFT JOIN core.tblcategorias ca ON ca.id = p.categoria_id
         WHERE i.comanda_id = $1
         ORDER BY i.orden`,
        [id]
      ),
      pool.query('SELECT id, url, public_id, orden FROM core.tblcomanda_imagenes WHERE comanda_id = $1 ORDER BY orden', [id]),
      pool.query(
        `SELECT f.id, f.area, f.version, f.usuario_id, u.nombre || ' ' || u.apellido AS usuario_nombre, f.created_at
         FROM core.tblcomanda_confirmaciones f JOIN core.tblusuarios u ON u.id = f.usuario_id
         WHERE f.comanda_id = $1
         ORDER BY f.created_at DESC, f.id DESC`,
        [id]
      ),
      pool.query(
        `SELECT h.id, h.evento, h.version, u.nombre || ' ' || u.apellido AS usuario_nombre, h.cambios, h.snapshot, h.created_at
         FROM core.tblcomanda_historial h JOIN core.tblusuarios u ON u.id = h.usuario_id
         WHERE h.comanda_id = $1
         ORDER BY h.created_at DESC, h.id DESC`,
        [id]
      ),
    ]);
    if (cabeceraR.rows.length === 0) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
    const c = cabeceraR.rows[0];

    // Las confirmaciones vienen de la más reciente a la más vieja: la primera de cada área es su última firma
    const firmaDe = (area) => {
      const f = confirmacionesR.rows.find((x) => x.area === area);
      return f ? firmaArea(f.version, f.usuario_nombre, f.created_at, c.version) : firmaArea(null, null, null, c.version);
    };
    const firmas = { hornos: firmaDe('hornos'), decoracion: firmaDe('decoracion') };

    const activa = c.estado === 'activa';
    const area = PRODUCCION.includes(req.usuario.rol) ? req.usuario.rol : null;
    const firmaPropia = area === 'hornos' ? firmas.hornos : firmas.decoracion;

    // Re-firma: qué cambió desde la versión que confirmó SU área (su snapshot quedó en el historial)
    let cambiosPendientes = null;
    if (area && !firmaPropia.vigente && firmaPropia.version !== null) {
      const confirmada = historialR.rows.find((h) => h.version === firmaPropia.version && h.snapshot !== null);
      if (confirmada) {
        const vigente = snapshotProduccion(comandaDeFilas(c, renglonesR.rows, imagenesR.rows));
        cambiosPendientes = diffProduccion(confirmada.snapshot, vigente);
      }
    }

    const editor = activa && esEditor(req.usuario, c);
    const esCaptura = CAPTURA.includes(req.usuario.rol);
    res.json({
      success: true,
      comanda: {
        id: c.id,
        folio: c.folio,
        estado: c.estado,
        sucursal: c.sucursal,
        cliente_nombre: c.cliente_nombre,
        cliente_telefono: c.cliente_telefono,
        fecha_entrega: c.fecha_entrega,
        hora_entrega: c.hora_entrega,
        dias_restantes: c.dias_restantes,
        semaforo: semaforo(c.estado, c.dias_restantes, ajustes),
        notas: c.notas,
        mesa_color_capacillos: c.mesa_color_capacillos,
        mesa_color_betun: c.mesa_color_betun,
        mesa_color_grageas: c.mesa_color_grageas,
        subtotal: c.subtotal,
        descuento: c.descuento,
        total: c.total,
        anticipo: c.anticipo,
        saldo: c.saldo,
        version: c.version,
        actualizada_en: c.updated_at.toISOString(),
        tomado_por: { id: c.tomado_por, nombre: c.tomado_por_nombre },
        created_at: c.created_at,
        entregada_at: c.entregada_at,
        entregada_por_nombre: c.entregada_por_nombre,
        saldo_cobrado: c.saldo_cobrado,
        cancelada_at: c.cancelada_at,
        cancelada_por_nombre: c.cancelada_por_nombre,
        motivo_cancelacion: c.motivo_cancelacion,
        items: renglonesR.rows.map(renglonRespuesta),
        imagenes: imagenesR.rows,
        firmas,
        confirmaciones: confirmacionesR.rows.map((f) => ({ ...f, vigente: f.version === c.version })),
        historial: historialR.rows.map((h) => ({
          id: h.id, evento: h.evento, version: h.version, usuario_nombre: h.usuario_nombre,
          // jsonb reordena las llaves: se devuelven en el orden de CambioCampo
          cambios: (h.cambios ?? []).map(({ campo, antes, despues }) => ({ campo, antes, despues })),
          created_at: h.created_at,
        })),
        cambios_pendientes: cambiosPendientes,
      },
      permisos: {
        editar: editor,
        cancelar: editor,
        entregar: activa && esCaptura,
        imprimir: esCaptura,
        confirmar: area && activa && !firmaPropia.vigente ? area : null,
      },
    });
  } catch (error) {
    console.error('Error GET /comandas/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener la comanda' });
  }
});

// ══════════════════════════════════════
// ALTA, EDICIÓN Y CICLO DE VIDA
// ══════════════════════════════════════

// ── Alta de comanda ──
router.post('/', PUEDE_CAPTURAR, async (req, res) => {
  let client;
  try {
    const { hoy, ajustes } = await leerContexto(pool);
    // Validación completa ANTES de abrir la transacción (y de tomar folio)
    const { errores, comanda, dias_restantes: diasRestantes } = await validarComanda(pool, req.body, { hoy, ajustes, actual: null });
    if (errores.length > 0) return rechazar(res, errores);

    client = await pool.connect();
    await client.query('BEGIN');
    // El folio sale de un contador de una fila DENTRO de la transacción: si el
    // alta falla, el número se libera y no quedan huecos (una secuencia sí los deja)
    const folioR = await client.query('UPDATE core.tblcomanda_folio SET ultimo = ultimo + 1 WHERE id = 1 RETURNING ultimo');
    const folio = folioR.rows[0].ultimo;
    const cabeceraR = await client.query(
      `INSERT INTO core.tblcomandas
         (folio, cliente_nombre, cliente_telefono, fecha_entrega, hora_entrega, notas,
          mesa_color_capacillos, mesa_color_betun, mesa_color_grageas, descuento, total, anticipo, tomado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [folio, ...valoresCabecera(comanda), req.usuario.id]
    );
    const id = cabeceraR.rows[0].id;
    await insertarRenglones(client, id, comanda.items);
    await insertarImagenes(client, id, comanda.imagenes);
    await client.query(
      `INSERT INTO core.tblcomanda_historial (comanda_id, version, evento, usuario_id, cambios, snapshot)
       VALUES ($1, 1, 'creada', $2, NULL, $3::jsonb)`,
      [id, req.usuario.id, JSON.stringify(snapshotProduccion(comanda))]
    );
    await client.query('COMMIT');

    await Promise.all([
      notificarRoles(PRODUCCION, {
        tipo: 'pedido',
        titulo: `Nueva comanda #${folio}`,
        mensaje: `Entrega ${fechaLarga(comanda.fecha_entrega)} a las ${horaLegible(comanda.hora_entrega)} · ${resumenRenglones(comanda.items)}. Revísala y confirma de enterado.`,
      }),
      registrarAuditoria({
        usuario_id: req.usuario.id, accion: 'Creó comanda', entidad: 'comanda', entidad_id: id,
        detalles: `#${folio} · ${comanda.cliente_nombre} · entrega ${comanda.fecha_entrega}`, ip: req.ip,
      }),
    ]);

    res.status(201).json({
      success: true,
      comanda: { id, folio },
      advertencias: avisoAnticipacion(diasRestantes, ajustes),
      message: `Comanda #${folio} creada`,
    });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error POST /comandas:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear la comanda' });
  } finally {
    if (client) client.release();
  }
});

// ── Edición: re-firma si cambia producción, misma versión si solo cambia cliente o cobro ──
router.put('/:id', PUEDE_CAPTURAR, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
  const marca = typeof req.body?.actualizada_en === 'string' ? Date.parse(req.body.actualizada_en) : NaN;
  if (Number.isNaN(marca)) return rechazar(res, ['Falta la versión que editaste (actualizada_en): recarga la comanda']);
  let client;
  try {
    const { hoy, ajustes } = await leerContexto(pool);
    client = await pool.connect();
    await client.query('BEGIN');
    const leida = await leerParaEditar(client, id);
    if (!leida) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
    }
    const { cabecera, comanda: actual } = leida;
    if (!esEditor(req.usuario, cabecera)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: soloEditores('modificar') });
    }
    if (cabecera.estado !== 'activa') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: yaCerrada(cabecera.estado, 'modificar') });
    }
    // Concurrencia: el updated_at que recibió el formulario debe seguir igual (al milisegundo)
    if (cabecera.updated_at.getTime() !== marca) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        codigo: 'COMANDA_DESACTUALIZADA',
        message: 'Alguien más modificó esta comanda mientras la editabas. Recárgala para ver la versión actual.',
      });
    }
    const { errores, comanda: nueva, dias_restantes: diasRestantes } = await validarComanda(client, req.body, { hoy, ajustes, actual });
    if (errores.length > 0) {
      await client.query('ROLLBACK');
      return rechazar(res, errores);
    }

    const antes = snapshotProduccion(actual);
    const despues = snapshotProduccion(nueva);
    const cambioProduccion = JSON.stringify(antes) !== JSON.stringify(despues);
    const cambiosProduccion = cambioProduccion ? diffProduccion(antes, despues) : [];
    const cambiosCobro = diffAdministrativo(actual, nueva);
    if (!cambioProduccion && cambiosCobro.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: true, sin_cambios: true, message: 'No hubo cambios' });
    }

    // La versión solo sube si cambia lo que producción necesita saber: las
    // firmas anteriores dejan de estar vigentes (no se borran)
    const version = cambioProduccion ? cabecera.version + 1 : cabecera.version;
    await client.query(
      `UPDATE core.tblcomandas
       SET cliente_nombre = $2, cliente_telefono = $3, fecha_entrega = $4, hora_entrega = $5, notas = $6,
           mesa_color_capacillos = $7, mesa_color_betun = $8, mesa_color_grageas = $9,
           descuento = $10, total = $11, anticipo = $12, version = $13
       WHERE id = $1`,
      [id, ...valoresCabecera(nueva), version]
    );
    const cambianRenglones = JSON.stringify(antes.items) !== JSON.stringify(despues.items)
      || actual.items.some((r, i) => r.precio_centavos !== nueva.items.at(i).precio_centavos);
    if (cambianRenglones) {
      await client.query('DELETE FROM core.tblcomanda_items WHERE comanda_id = $1', [id]);
      await insertarRenglones(client, id, nueva.items);
    }
    if (JSON.stringify(antes.imagenes) !== JSON.stringify(despues.imagenes)) {
      await client.query('DELETE FROM core.tblcomanda_imagenes WHERE comanda_id = $1', [id]);
      await insertarImagenes(client, id, nueva.imagenes);
    }
    await client.query(
      `INSERT INTO core.tblcomanda_historial (comanda_id, version, evento, usuario_id, cambios, snapshot)
       VALUES ($1, $2, 'modificada', $3, $4::jsonb, $5::jsonb)`,
      [id, version, req.usuario.id, JSON.stringify([...cambiosProduccion, ...cambiosCobro]), cambioProduccion ? JSON.stringify(despues) : null]
    );
    await client.query('COMMIT');

    const folio = cabecera.folio;
    await Promise.all([
      // Cliente, teléfono y cobro no le importan a producción: solo se avisa la re-firma
      cambioProduccion
        ? notificarRoles(PRODUCCION, {
          tipo: 'alerta',
          titulo: `Cambió la comanda #${folio}`,
          mensaje: `${cambiosProduccion.slice(0, 3).map(textoCambio).join('; ')}. Vuelve a confirmar de enterado.`,
        })
        : null,
      registrarAuditoria({
        usuario_id: req.usuario.id, accion: 'Editó comanda', entidad: 'comanda', entidad_id: id,
        detalles: cambioProduccion ? `#${folio} · versión ${version}` : `#${folio} · datos del cliente o cobro`, ip: req.ip,
      }),
    ]);

    res.json({
      success: true,
      comanda: { id, folio, version },
      cambio_produccion: cambioProduccion,
      // El aviso de poco tiempo importa cuando producción tiene algo nuevo que preparar
      advertencias: cambioProduccion ? avisoAnticipacion(diasRestantes, ajustes) : [],
      message: `Comanda #${folio} actualizada`,
    });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /comandas/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar la comanda' });
  } finally {
    if (client) client.release();
  }
});

// ── Enterado de hornos o decoración (irreversible, ligado a la versión leída) ──
router.post('/:id/confirmar', SOLO_PRODUCCION, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
  const version = aNumero(req.body?.version);
  if (!esId(version)) return rechazar(res, ['Indica la versión de la comanda que leíste']);
  // El área es el rol leído de la base, nunca un dato que mande el cliente
  const area = req.usuario.rol;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, folio, estado, version FROM core.tblcomandas WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
    }
    const comanda = rows[0];
    if (comanda.estado !== 'activa') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: yaCerrada(comanda.estado, 'confirmar') });
    }
    if (version !== comanda.version) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        codigo: 'VERSION_DESACTUALIZADA',
        version_actual: comanda.version,
        message: 'La comanda cambió. Revisa los cambios antes de confirmar.',
      });
    }
    let confirmacion;
    try {
      const insertada = await client.query(
        `INSERT INTO core.tblcomanda_confirmaciones (comanda_id, area, version, usuario_id)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [id, area, version, req.usuario.id]
      );
      confirmacion = insertada.rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
      // Otra persona de la misma área ya firmó esta versión (UNIQUE comanda/área/versión)
      await client.query('ROLLBACK');
      const previa = await pool.query(
        `SELECT u.nombre || ' ' || u.apellido AS nombre
         FROM core.tblcomanda_confirmaciones f JOIN core.tblusuarios u ON u.id = f.usuario_id
         WHERE f.comanda_id = $1 AND f.area = $2 AND f.version = $3`,
        [id, area, version]
      );
      return res.status(409).json({
        success: false,
        codigo: 'YA_CONFIRMADA',
        message: `Esta versión ya la confirmó ${previa.rows[0]?.nombre ?? 'alguien más'} (${AREA_LEGIBLE.get(area)}).`,
      });
    }
    await client.query('COMMIT');

    await registrarAuditoria({
      usuario_id: req.usuario.id, accion: 'Confirmó de enterado comanda', entidad: 'comanda', entidad_id: id,
      detalles: `#${comanda.folio} · versión ${version} · ${AREA_LEGIBLE.get(area)}`, ip: req.ip,
    });

    res.status(201).json({
      success: true,
      confirmacion: {
        id: confirmacion.id,
        area,
        version,
        usuario_id: req.usuario.id,
        usuario_nombre: req.usuario.nombre,
        created_at: confirmacion.created_at,
        vigente: true,
      },
      message: 'Enterado registrado',
    });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error POST /comandas/:id/confirmar:', error.message);
    res.status(500).json({ success: false, message: 'Error al registrar el enterado' });
  } finally {
    if (client) client.release();
  }
});

// ── Cancelar (quien la tomó, gerencia o dirección) ──
router.put('/:id/cancelar', PUEDE_CAPTURAR, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
  const errores = [];
  const motivo = texto(req.body?.motivo, 'Motivo', 300, errores, { min: 5 });
  if (errores.length > 0) return rechazar(res, errores);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, folio, estado, version, tomado_por FROM core.tblcomandas WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
    }
    const comanda = rows[0];
    if (!esEditor(req.usuario, comanda)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: soloEditores('cancelar') });
    }
    if (comanda.estado !== 'activa') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: yaCerrada(comanda.estado, 'cancelar') });
    }
    await client.query(
      `UPDATE core.tblcomandas
       SET estado = 'cancelada', cancelada_at = NOW(), cancelada_por = $2, motivo_cancelacion = $3
       WHERE id = $1`,
      [id, req.usuario.id, motivo]
    );
    await client.query(
      `INSERT INTO core.tblcomanda_historial (comanda_id, version, evento, usuario_id, cambios, snapshot)
       VALUES ($1, $2, 'cancelada', $3, $4::jsonb, NULL)`,
      [id, comanda.version, req.usuario.id, JSON.stringify([{ campo: 'Motivo de cancelación', antes: null, despues: motivo }])]
    );
    await client.query('COMMIT');

    await Promise.all([
      notificarRoles(PRODUCCION, { tipo: 'alerta', titulo: `Comanda #${comanda.folio} cancelada`, mensaje: `Motivo: ${motivo}` }),
      registrarAuditoria({
        usuario_id: req.usuario.id, accion: 'Canceló comanda', entidad: 'comanda', entidad_id: id,
        detalles: `#${comanda.folio} · ${recortar(motivo, 80)}`, ip: req.ip,
      }),
    ]);

    res.json({ success: true, message: `Comanda #${comanda.folio} cancelada` });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /comandas/:id/cancelar:', error.message);
    res.status(500).json({ success: false, message: 'Error al cancelar la comanda' });
  } finally {
    if (client) client.release();
  }
});

// ── Marcar entregada (cualquier rol de captura) ──
router.put('/:id/entregar', PUEDE_CAPTURAR, async (req, res) => {
  const id = idDe(req.params.id);
  if (!id) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
  const saldo = aNumero(req.body?.saldo_cobrado);
  // Tope: lo que cabe en NUMERIC(10,2)
  if (!(saldo >= 0 && saldo <= 99999999.99)) return rechazar(res, ['Saldo cobrado: indica un monto de $0.00 o más']);
  const saldoCentavos = aCentavos(saldo);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, folio, estado, version FROM core.tblcomandas WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Comanda no encontrada' });
    }
    const comanda = rows[0];
    if (comanda.estado !== 'activa') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: yaCerrada(comanda.estado, 'entregar') });
    }
    const firmadas = await client.query(
      'SELECT area FROM core.tblcomanda_confirmaciones WHERE comanda_id = $1 AND version = $2',
      [id, comanda.version]
    );
    await client.query(
      `UPDATE core.tblcomandas
       SET estado = 'entregada', entregada_at = NOW(), entregada_por = $2, saldo_cobrado = $3
       WHERE id = $1`,
      [id, req.usuario.id, decimal(saldoCentavos)]
    );
    await client.query(
      `INSERT INTO core.tblcomanda_historial (comanda_id, version, evento, usuario_id, cambios, snapshot)
       VALUES ($1, $2, 'entregada', $3, $4::jsonb, NULL)`,
      [id, comanda.version, req.usuario.id, JSON.stringify([{ campo: 'Saldo cobrado', antes: null, despues: moneda(saldoCentavos) }])]
    );
    await client.query('COMMIT');

    await registrarAuditoria({
      usuario_id: req.usuario.id, accion: 'Entregó comanda', entidad: 'comanda', entidad_id: id,
      detalles: `#${comanda.folio} · saldo ${moneda(saldoCentavos)}`, ip: req.ip,
    });

    // Entregar no exige firmas (decisión del negocio), pero queda dicho qué área faltó
    const areasFirmadas = new Set(firmadas.rows.map((f) => f.area));
    const advertencias = PRODUCCION
      .filter((a) => !areasFirmadas.has(a))
      .map((a) => `${AREA_LEGIBLE.get(a)} no confirmó de enterado la versión ${comanda.version}`);
    res.json({ success: true, message: `Comanda #${comanda.folio} entregada`, advertencias });
  } catch (error) {
    if (client) await deshacer(client);
    console.error('Error PUT /comandas/:id/entregar:', error.message);
    res.status(500).json({ success: false, message: 'Error al marcar la comanda como entregada' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
