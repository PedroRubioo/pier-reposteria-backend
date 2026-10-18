// routes/resenasRoutes.js — Reseñas y Likes
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { textoLibre, enteroPositivo } = require('../utils/validacionCliente');

const PALABRAS_INAPROPIADAS = ['mierda','puta','puto','pendejo','pendeja','idiota','estupido','estúpido','cabron','cabrón','chinga','verga','culo','joder','jodido','mamada','pinche','culero','culera','baboso','babosa','imbecil','imbécil','tarado','tarada','zorra','bastardo','maldito','maldita','carajo','coño','huevon','huevón','maricon','maricón','perra','perro hijue','gonorrea','malparido','malparida','hp','hdp','wtf','ctm','ptm'];

// Reseñas destacadas (público) — para landing page
// Filtra: 5 estrellas, aprobadas, sin palabras inapropiadas, distintos autores, incluye producto
router.get('/destacadas', async (req, res) => {
  try {
    const limite = Math.min(parseInt(req.query.limite) || 3, 10);
    const minRating = parseInt(req.query.min_rating) || 5;
    // Traer más de las necesarias para filtrar por contenido positivo
    const result = await pool.query(`
      SELECT r.id, r.producto_id, r.rating, r.titulo, r.comentario, r.verificada, r.created_at,
        u.nombre AS autor_nombre, u.apellido AS autor_apellido,
        p.nombre AS producto_nombre
      FROM core.tblresenas r
      JOIN core.tblusuarios u ON r.usuario_id = u.id
      JOIN core.tblproductos p ON r.producto_id = p.id
      WHERE r.estado = 'aprobada' AND r.rating >= $1
      ORDER BY r.verificada DESC, r.util_count DESC, r.created_at DESC
      LIMIT $2
    `, [minRating, limite * 3]);

    // Filtrar: sin palabras inapropiadas, comentario coherente (min 10 chars), distintos autores
    const autoresVistos = new Set();
    const filtradas = [];
    for (const r of result.rows) {
      const texto = `${r.titulo || ''} ${r.comentario}`.toLowerCase();
      const tieneInapropiado = PALABRAS_INAPROPIADAS.some(p => texto.includes(p));
      if (tieneInapropiado) continue;
      if (r.comentario.length < 10) continue;
      const autorKey = `${r.autor_nombre}-${r.autor_apellido}`;
      if (autoresVistos.has(autorKey)) continue;
      autoresVistos.add(autorKey);
      filtradas.push(r);
      if (filtradas.length >= limite) break;
    }

    res.json({ success: true, resenas: filtradas });
  } catch (error) {
    console.error('Error GET /resenas/destacadas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reseñas destacadas' });
  }
});

// Reseñas de un producto (público)
router.get('/producto/:productoId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.rating, r.titulo, r.comentario, r.fotos, r.util_count, r.verificada, r.created_at,
        u.nombre AS autor_nombre, u.apellido AS autor_apellido, r.respuesta_negocio
      FROM core.tblresenas r
      JOIN core.tblusuarios u ON r.usuario_id = u.id
      WHERE r.producto_id = $1 AND r.estado = 'aprobada'
      ORDER BY r.created_at DESC
    `, [req.params.productoId]);
    res.json({ success: true, resenas: result.rows });
  } catch (error) {
    console.error('Error GET /resenas/producto/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reseñas' });
  }
});

// Calificación, título y comentario de una reseña (Diseno_Panel_Cliente.md
// §5.8). El título cabe en varchar(100); el comentario no tiene tope (la app
// no lo limita). Devuelve el mensaje del primer campo inválido
function validarResena({ rating, titulo, comentario }) {
  const calificacion = enteroPositivo(rating);
  if (!calificacion || calificacion > 5) return { error: 'La calificación debe ser un número entero de 1 a 5' };
  const tituloLimpio = textoLibre(titulo, { max: 100, opcional: true });
  if (!tituloLimpio.ok) return { error: 'El título puede tener hasta 100 caracteres' };
  const comentarioLimpio = textoLibre(comentario, { min: 1 });
  if (!comentarioLimpio.ok) return { error: 'Escribe tu opinión' };
  return { calificacion, titulo: tituloLimpio.valor, comentario: comentarioLimpio.valor };
}
const tieneInapropiado = (titulo, comentario) => {
  const texto = `${titulo || ''} ${comentario}`.toLowerCase();
  return PALABRAS_INAPROPIADAS.some(p => texto.includes(p));
};

// Crear reseña (cliente)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { producto_id, fotos } = req.body;
    const productoId = enteroPositivo(producto_id);
    if (!productoId) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    const datos = validarResena(req.body);
    if (datos.error) return res.status(400).json({ success: false, message: datos.error });
    const { calificacion, titulo, comentario } = datos;

    const producto = await pool.query('SELECT 1 FROM core.tblproductos WHERE id = $1', [productoId]);
    if (producto.rows.length === 0) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    // Verificar que el usuario compró el producto (recogido o entregado)
    const compro = await pool.query(
      `SELECT 1 FROM core.tblpedido_items pi
       JOIN core.tblpedidos p ON pi.pedido_id = p.id
       WHERE p.usuario_id = $1 AND pi.producto_id = $2 AND p.estado IN ('completado', 'entregado') LIMIT 1`,
      [req.user.userId, productoId]
    );
    const verificada = compro.rows.length > 0;

    // Verificar que no haya reseñado ya
    const yaReseno = await pool.query(
      'SELECT id FROM core.tblresenas WHERE usuario_id = $1 AND producto_id = $2', [req.user.userId, productoId]
    );
    if (yaReseno.rows.length > 0) return res.status(400).json({ success: false, message: 'Ya dejaste una reseña para este producto' });

    const contieneInapropiado = tieneInapropiado(titulo, comentario);
    const auto_aprobada = !contieneInapropiado && calificacion >= 4;
    const estado = auto_aprobada ? 'aprobada' : 'pendiente';

    const result = await pool.query(
      `INSERT INTO core.tblresenas (producto_id, usuario_id, rating, titulo, comentario, fotos, estado, auto_aprobada, verificada, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
      [productoId, req.user.userId, calificacion, titulo, comentario, fotos ? JSON.stringify(fotos) : null, estado, auto_aprobada, verificada]
    );
    res.status(201).json({
      success: true,
      resena: result.rows[0],
      message: contieneInapropiado
        ? 'Tu reseña requiere validación manual antes de publicarse'
        : (auto_aprobada ? 'Reseña publicada' : 'Reseña en revisión')
    });
  } catch (error) {
    // Doble envío: el segundo choca con el índice único (producto, usuario)
    if (error.code === '23505' && error.constraint === 'tblresenas_producto_id_usuario_id_key') {
      return res.status(400).json({ success: false, message: 'Ya dejaste una reseña para este producto' });
    }
    console.error('Error POST /resenas:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear reseña' });
  }
});

// Mis reseñas (cliente)
router.get('/mis-resenas', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, p.nombre AS producto_nombre, p.imagen_url AS producto_imagen
      FROM core.tblresenas r
      JOIN core.tblproductos p ON r.producto_id = p.id
      WHERE r.usuario_id = $1 ORDER BY r.created_at DESC
    `, [req.user.userId]);
    res.json({ success: true, resenas: result.rows });
  } catch (error) {
    console.error('Error GET /resenas/mis-resenas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reseñas' });
  }
});

// Reseñas que el usuario marcó como útiles (opcional: de un producto)
router.get('/mis-utiles', verifyToken, async (req, res) => {
  try {
    const { producto_id } = req.query;
    let productoId = null;
    if (producto_id !== undefined && producto_id !== '') {
      productoId = enteroPositivo(producto_id);
      if (!productoId) return res.status(400).json({ success: false, message: 'Producto no válido' });
    }
    const result = await pool.query(
      `SELECT l.resena_id FROM core.tblresena_likes l JOIN core.tblresenas r ON r.id = l.resena_id
        WHERE l.usuario_id = $1 AND ($2::int IS NULL OR r.producto_id = $2)`,
      [req.user.userId, productoId]
    );
    res.json({ success: true, ids: result.rows.map(r => r.resena_id) });
  } catch (error) {
    console.error('Error GET /resenas/mis-utiles:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener tus reseñas útiles' });
  }
});

// Marcar o desmarcar una reseña como útil. La reseña se bloquea mientras se
// alterna: dos clics seguidos no cuentan doble
router.post('/:id/like', verifyToken, async (req, res) => {
  const resenaId = enteroPositivo(req.params.id);
  if (!resenaId) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });
  const userId = req.user.userId;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const resenaData = await client.query(
      `SELECT r.usuario_id, r.estado, p.nombre AS producto_nombre
         FROM core.tblresenas r JOIN core.tblproductos p ON r.producto_id = p.id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [resenaId]
    );
    const resena = resenaData.rows[0];
    if (!resena || resena.estado !== 'aprobada') {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Reseña no encontrada' });
    }
    if (resena.usuario_id === userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No puedes marcar como útil tu propia opinión' });
    }

    let liked;
    let cambio = 0;
    const quitado = await client.query('DELETE FROM core.tblresena_likes WHERE resena_id = $1 AND usuario_id = $2 RETURNING id', [resenaId, userId]);
    if (quitado.rows.length > 0) {
      liked = false;
      cambio = -1;
    } else {
      const agregado = await client.query(
        `INSERT INTO core.tblresena_likes (resena_id, usuario_id, created_at) VALUES ($1, $2, NOW())
         ON CONFLICT (resena_id, usuario_id) DO NOTHING RETURNING id`,
        [resenaId, userId]
      );
      liked = true;
      cambio = agregado.rows.length > 0 ? 1 : 0;
    }
    const conteo = await client.query(
      'UPDATE core.tblresenas SET util_count = GREATEST(COALESCE(util_count, 0) + $2, 0), updated_at = NOW() WHERE id = $1 RETURNING util_count',
      [resenaId, cambio]
    );
    await client.query('COMMIT');

    res.json({ success: true, liked, message: liked ? 'Like agregado' : 'Like removido', util_count: conteo.rows[0].util_count });

    // Después de responder: avisar al autor
    if (liked && cambio > 0) {
      const { crearNotificacion } = require('../services/notificacionHelper');
      crearNotificacion({
        usuario_id: resena.usuario_id,
        tipo: 'sistema',
        titulo: 'Tu opinión fue útil',
        mensaje: `A alguien le pareció útil tu reseña sobre "${resena.producto_nombre}".`
      });
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error POST /resenas/:id/like:', error.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error al dar like' });
  } finally {
    if (client) client.release();
  }
});

// Listar todas (empleado+) + aprobar/rechazar
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `SELECT r.*, u.nombre AS autor_nombre, u.apellido AS autor_apellido, p.nombre AS producto_nombre
      FROM core.tblresenas r JOIN core.tblusuarios u ON r.usuario_id = u.id JOIN core.tblproductos p ON r.producto_id = p.id`;
    const params = [];
    if (estado) { query += ' WHERE r.estado = $1'; params.push(estado); }
    query += ' ORDER BY r.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, resenas: result.rows });
  } catch (error) {
    console.error('Error GET /resenas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reseñas' });
  }
});

router.put('/:id/estado', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, motivo_rechazo, respuesta_negocio } = req.body;
    // Si solo envían respuesta_negocio sin estado, actualizar solo la respuesta
    if (!estado && respuesta_negocio) {
      const result = await pool.query(
        'UPDATE core.tblresenas SET respuesta_negocio=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
        [respuesta_negocio, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });
      const resena = result.rows[0];
      // La respuesta ya quedó guardada: si el nombre no se puede leer, la
      // bitácora y el aviso siguen sin él en vez de responder 500
      const prodInfo = await pool.query('SELECT nombre FROM core.tblproductos WHERE id = $1', [resena.producto_id]).catch(() => ({ rows: [] }));
      registrarAuditoria({
        usuario_id: req.user.userId, accion: 'Respondió reseña', entidad: 'resena', entidad_id: resena.id,
        detalles: `"${prodInfo.rows[0]?.nombre || 'un producto'}" · ${resena.rating}/5`, ip: req.ip,
      });
      // Notificar al cliente
      try {
        const { notificarConEmail } = require('../services/notificacionHelper');
        await notificarConEmail({ usuario_id: resena.usuario_id, tipo: 'sistema', titulo: 'Pier respondió a tu reseña', mensaje: `Respondimos a tu reseña del producto "${prodInfo.rows[0]?.nombre || ''}": ${respuesta_negocio.substring(0, 100)}` });
      } catch (notifErr) { console.error('Error notificación respuesta:', notifErr.message); }
      return res.json({ success: true, resena });
    }
    if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ success: false, message: 'Estado: aprobada o rechazada' });
    const result = await pool.query(
      `UPDATE core.tblresenas SET estado=$1, motivo_rechazo=$2, respuesta_negocio=$3, updated_at=NOW() WHERE id=$4 RETURNING *`,
      [estado, motivo_rechazo || null, respuesta_negocio || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });

    const resena = result.rows[0];
    const productoData = await pool.query('SELECT nombre FROM core.tblproductos WHERE id = $1', [resena.producto_id]);
    const productoNombre = productoData.rows[0]?.nombre || 'un producto';
    registrarAuditoria({
      usuario_id: req.user.userId, accion: resena.estado === 'aprobada' ? 'Aprobó reseña' : 'Rechazó reseña', entidad: 'resena', entidad_id: resena.id,
      detalles: `"${productoNombre}" · ${resena.rating}/5${resena.estado === 'rechazada' && resena.motivo_rechazo ? ` · ${recortar(resena.motivo_rechazo, 80)}` : ''}`, ip: req.ip,
    });

    // Notificar al autor de la reseña
    const { crearNotificacion } = require('../services/notificacionHelper');
    if (respuesta_negocio) {
      await crearNotificacion({
        usuario_id: resena.usuario_id,
        tipo: 'sistema',
        titulo: 'Pier respondió a tu reseña',
        mensaje: `Pier Repostería respondió a tu opinión sobre "${productoNombre}": "${respuesta_negocio.substring(0, 80)}${respuesta_negocio.length > 80 ? '...' : ''}"`
      });
    } else if (estado === 'rechazada') {
      await crearNotificacion({
        usuario_id: resena.usuario_id,
        tipo: 'sistema',
        titulo: 'Reseña no publicada',
        mensaje: `Tu reseña sobre "${productoNombre}" no fue publicada. ${motivo_rechazo ? 'Motivo: ' + motivo_rechazo : 'Contacta a soporte si tienes dudas.'}`
      });
    }

    res.json({ success: true, resena });
  } catch (error) {
    console.error('Error PUT /resenas/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar reseña' });
  }
});

// Editar reseña propia (cliente). Misma regla que al crear: 4 o 5 estrellas
// sin palabras inapropiadas se publica; lo demás vuelve a revisión
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const resenaId = enteroPositivo(req.params.id);
    if (!resenaId) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });
    const datos = validarResena(req.body);
    if (datos.error) return res.status(400).json({ success: false, message: datos.error });
    const { calificacion, titulo, comentario } = datos;
    // Verificar que la reseña pertenece al usuario
    const resena = await pool.query('SELECT id, usuario_id FROM core.tblresenas WHERE id = $1', [resenaId]);
    if (resena.rows.length === 0) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });
    if (resena.rows[0].usuario_id !== req.user.userId) return res.status(403).json({ success: false, message: 'No puedes editar esta reseña' });

    const inapropiado = tieneInapropiado(titulo, comentario);
    const nuevoEstado = !inapropiado && calificacion >= 4 ? 'aprobada' : 'pendiente';

    const result = await pool.query(
      'UPDATE core.tblresenas SET rating=$1, titulo=$2, comentario=$3, estado=$4, updated_at=NOW() WHERE id=$5 RETURNING *',
      [calificacion, titulo, comentario, nuevoEstado, resenaId]
    );
    const mensaje = inapropiado
      ? 'Tu reseña fue actualizada y requiere validación manual antes de publicarse'
      : (nuevoEstado === 'aprobada' ? 'Reseña actualizada' : 'Reseña actualizada: la revisaremos antes de publicarla');
    res.json({ success: true, resena: result.rows[0], message: mensaje });
  } catch (error) {
    console.error('Error PUT /resenas/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar reseña' });
  }
});

module.exports = router;