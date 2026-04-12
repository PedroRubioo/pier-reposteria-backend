// routes/resenasRoutes.js — Reseñas y Likes
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

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

// Crear reseña (cliente)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { producto_id, rating, titulo, comentario, fotos } = req.body;
    if (!producto_id || !rating || !comentario) return res.status(400).json({ success: false, message: 'Producto, rating y comentario son requeridos' });
    if (rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating debe ser entre 1 y 5' });

    // Verificar que el usuario compró el producto
    const compro = await pool.query(
      `SELECT 1 FROM core.tblpedido_items pi
       JOIN core.tblpedidos p ON pi.pedido_id = p.id
       WHERE p.usuario_id = $1 AND pi.producto_id = $2 AND p.estado = 'completado' LIMIT 1`,
      [req.user.userId, producto_id]
    );
    const verificada = compro.rows.length > 0;

    // Verificar que no haya reseñado ya
    const yaReseno = await pool.query(
      'SELECT id FROM core.tblresenas WHERE usuario_id = $1 AND producto_id = $2', [req.user.userId, producto_id]
    );
    if (yaReseno.rows.length > 0) return res.status(400).json({ success: false, message: 'Ya dejaste una reseña para este producto' });

    const textoCompleto = `${titulo || ''} ${comentario}`.toLowerCase();
    const contieneInapropiado = PALABRAS_INAPROPIADAS.some(p => textoCompleto.includes(p));
    const auto_aprobada = !contieneInapropiado && rating >= 4;
    const estado = auto_aprobada ? 'aprobada' : 'pendiente';

    const result = await pool.query(
      `INSERT INTO core.tblresenas (producto_id, usuario_id, rating, titulo, comentario, fotos, estado, auto_aprobada, verificada, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
      [producto_id, req.user.userId, rating, titulo || null, comentario, fotos ? JSON.stringify(fotos) : null, estado, auto_aprobada, verificada]
    );
    res.status(201).json({
      success: true,
      resena: result.rows[0],
      message: contieneInapropiado
        ? 'Tu reseña requiere validación manual antes de publicarse'
        : (auto_aprobada ? 'Reseña publicada' : 'Reseña en revisión')
    });
  } catch (error) {
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

// Dar like a reseña
router.post('/:id/like', verifyToken, async (req, res) => {
  try {
    const existe = await pool.query('SELECT id FROM core.tblresena_likes WHERE resena_id = $1 AND usuario_id = $2', [req.params.id, req.user.userId]);
    if (existe.rows.length > 0) {
      await pool.query('DELETE FROM core.tblresena_likes WHERE resena_id = $1 AND usuario_id = $2', [req.params.id, req.user.userId]);
      await pool.query('UPDATE core.tblresenas SET util_count = GREATEST(util_count - 1, 0), updated_at = NOW() WHERE id = $1', [req.params.id]);
      return res.json({ success: true, liked: false, message: 'Like removido' });
    }
    await pool.query('INSERT INTO core.tblresena_likes (resena_id, usuario_id, created_at) VALUES ($1,$2,NOW())', [req.params.id, req.user.userId]);
    await pool.query('UPDATE core.tblresenas SET util_count = util_count + 1, updated_at = NOW() WHERE id = $1', [req.params.id]);

    // Notificar al autor de la reseña que alguien le dio like
    const { crearNotificacion } = require('../services/notificacionHelper');
    const resenaData = await pool.query(
      `SELECT r.usuario_id, p.nombre AS producto_nombre FROM core.tblresenas r JOIN core.tblproductos p ON r.producto_id = p.id WHERE r.id = $1`,
      [req.params.id]
    );
    if (resenaData.rows.length > 0 && resenaData.rows[0].usuario_id !== req.user.userId) {
      await crearNotificacion({
        usuario_id: resenaData.rows[0].usuario_id,
        tipo: 'resena',
        titulo: 'Tu opinión fue útil',
        mensaje: `A alguien le pareció útil tu reseña sobre "${resenaData.rows[0].producto_nombre}".`
      });
    }

    res.json({ success: true, liked: true, message: 'Like agregado' });
  } catch (error) {
    console.error('Error POST /resenas/:id/like:', error.message);
    res.status(500).json({ success: false, message: 'Error al dar like' });
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
      // Notificar al cliente
      try {
        const { notificarConEmail } = require('../services/notificacionHelper');
        const prodInfo = await pool.query('SELECT nombre FROM core.tblproductos WHERE id = $1', [resena.producto_id]);
        await notificarConEmail({ usuario_id: resena.usuario_id, tipo: 'resena', titulo: 'Pier respondió a tu reseña', mensaje: `Respondimos a tu reseña del producto "${prodInfo.rows[0]?.nombre || ''}": ${respuesta_negocio.substring(0, 100)}` });
      } catch (notifErr) { console.error('Error notificación respuesta:', notifErr.message); }
      return res.json({ success: true, resena });
    }
    if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ success: false, message: 'Estado: aprobada o rechazada' });
    const result = await pool.query(
      `UPDATE core.tblresenas SET estado=$1, motivo_rechazo=$2, respuesta_negocio=$3, updated_at=NOW() WHERE id=$4 RETURNING *`,
      [estado, motivo_rechazo || null, respuesta_negocio || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Reseña no encontrada' });

    // Notificar al autor de la reseña
    const { crearNotificacion } = require('../services/notificacionHelper');
    const resena = result.rows[0];
    const productoData = await pool.query('SELECT nombre FROM core.tblproductos WHERE id = $1', [resena.producto_id]);
    const productoNombre = productoData.rows[0]?.nombre || 'un producto';

    if (respuesta_negocio) {
      await crearNotificacion({
        usuario_id: resena.usuario_id,
        tipo: 'resena',
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

module.exports = router;