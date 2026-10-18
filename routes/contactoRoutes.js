// routes/contactoRoutes.js — Mensajes del formulario «Envíanos un mensaje» (/contacto)
//
// El mensaje se guarda en core.tblcontacto_mensajes y llega al negocio por
// dos vías: un correo al buzón configurado en Contacto (con «responder a» el
// cliente, para contestarle directo) y un aviso en la campana de dirección,
// gerencia y empleados. Exento del sanitizador global: aquí se valida campo
// por campo, el SQL es parametrizado, el correo escapa el HTML y React escapa
// al mostrar.
const express = require('express');
const validator = require('validator');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { notificarRoles, enviarEmailNotificacion } = require('../services/notificacionHelper');

// Las mismas opciones del formulario, con su nombre legible
const TIPOS_PRODUCTO = new Map([
  ['pasteles', 'Pasteles'],
  ['roscas', 'Roscas'],
  ['pays', 'Pays'],
  ['postres', 'Postres'],
  ['cafeteria', 'Cafetería'],
  ['otro', 'Otro'],
]);
const ROLES_AVISO = ['direccion_general', 'gerencia', 'empleado'];
const MENSAJE_RECIBIDO = 'Recibimos tu mensaje. Te responderemos pronto.';

// Antiabuso: hasta 5 mensajes por IP cada 15 minutos (en memoria, como los
// demás límites del backend)
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_VENTANA = 5;
const enviosPorIp = new Map();
setInterval(() => {
  const corte = Date.now() - VENTANA_MS;
  for (const [ip, marcas] of enviosPorIp) {
    const vigentes = marcas.filter((t) => t > corte);
    if (vigentes.length) enviosPorIp.set(ip, vigentes);
    else enviosPorIp.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function excedeLimite(ip) {
  const ahora = Date.now();
  const marcas = (enviosPorIp.get(ip) || []).filter((t) => t > ahora - VENTANA_MS);
  if (marcas.length >= MAX_POR_VENTANA) {
    enviosPorIp.set(ip, marcas);
    return true;
  }
  marcas.push(ahora);
  enviosPorIp.set(ip, marcas);
  return false;
}

const texto = (valor) => (typeof valor === 'string' ? valor.normalize('NFC').replace(/\r\n?/g, '\n').trim() : '');
const escaparHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Correo del negocio: el de Contacto; si no hay, el general */
async function buzonDelNegocio() {
  const { rows } = await pool.query(
    `SELECT valor #>> '{}' AS email FROM core.tblconfiguracion_sistema
     WHERE (seccion = 'contacto' AND clave = 'email') OR (seccion = 'general' AND clave = 'email_contacto')
     ORDER BY (seccion = 'contacto') DESC
     LIMIT 1`
  );
  const email = rows[0] ? rows[0].email : null;
  return email && validator.isEmail(email) ? email : null;
}

/** Aviso en la campana del personal y correo al buzón; nunca lanza */
async function avisarAlNegocio({ id, nombre, email, telefono, tipo, mensaje }) {
  const tipoLegible = tipo ? TIPOS_PRODUCTO.get(tipo) : null;
  const datos = [email, telefono, tipoLegible].filter(Boolean).join(' · ');
  let buzon = null;
  try {
    buzon = await buzonDelNegocio();
  } catch (error) {
    console.error('Contacto: no se pudo leer el buzón del negocio:', error.message);
  }

  const filas = [
    ['Nombre', nombre],
    ['Correo', email],
    ['Teléfono', telefono],
    ['Le interesa', tipoLegible],
  ].filter(([, valor]) => valor);
  const contenido = `
    <h2>Nuevo mensaje desde la página de contacto</h2>
    <div class="highlight-box">
      ${filas.map(([etiqueta, valor]) => `<p style="margin:4px 0"><strong>${etiqueta}:</strong> ${escaparHtml(valor)}</p>`).join('')}
    </div>
    <p style="white-space:pre-line">${escaparHtml(mensaje)}</p>`;

  const [avisos, correo] = await Promise.all([
    notificarRoles(ROLES_AVISO, {
      tipo: 'aviso',
      titulo: `Mensaje de contacto: ${nombre}`.slice(0, 200),
      mensaje: `${datos}\n${mensaje}`,
    }),
    buzon
      ? enviarEmailNotificacion({
        email: buzon,
        nombre: 'Pier Repostería',
        asunto: `Nuevo mensaje de contacto de ${nombre}`,
        contenido,
        responderA: { email, nombre },
        pie: 'Responde a este correo para contestarle directamente al cliente.',
      })
      : Promise.resolve(false),
  ]);
  if (!avisos && !correo) console.error(`Contacto: el mensaje ${id} se guardó, pero no se pudo avisar por campana ni por correo`);
}

// Enviar mensaje de contacto (público)
router.post('/', async (req, res) => {
  const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};

  // Trampa para bots: un campo oculto que una persona nunca llena
  if (texto(cuerpo.sitio_web)) return res.status(201).json({ success: true, message: MENSAJE_RECIBIDO });

  const nombre = texto(cuerpo.nombre).replace(/\s+/g, ' ');
  const email = texto(cuerpo.email).toLowerCase();
  const telefono = texto(cuerpo.telefono).replace(/[\s().-]/g, '');
  const tipo = texto(cuerpo.tipo_producto);
  const mensaje = texto(cuerpo.mensaje).replace(/\n{3,}/g, '\n\n');

  const errores = [];
  if (nombre.length < 2 || nombre.length > 80) errores.push('Escribe tu nombre (de 2 a 80 caracteres).');
  if (email.length > 120 || !validator.isEmail(email)) errores.push('Escribe un correo válido.');
  if (telefono && !/^(\+?52)?\d{10}$/.test(telefono)) errores.push('El teléfono debe tener 10 dígitos.');
  if (tipo && !TIPOS_PRODUCTO.has(tipo)) errores.push('Elige un tipo de producto de la lista.');
  if (mensaje.length < 10 || mensaje.length > 2000) errores.push('Escribe un mensaje de 10 a 2000 caracteres.');
  if (errores.length) return res.status(400).json({ success: false, message: errores[0], errores });

  // Solo cuentan los mensajes válidos: un error al escribir no gasta el límite
  if (excedeLimite(req.ip)) {
    return res.status(429).json({ success: false, message: 'Ya recibimos varios mensajes desde tu conexión. Espera unos minutos o escríbenos por WhatsApp.' });
  }

  const telefono10 = telefono ? telefono.slice(-10) : null;
  let id;
  try {
    const result = await pool.query(
      `INSERT INTO core.tblcontacto_mensajes (nombre, email, telefono, tipo_producto, mensaje, leido, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW()) RETURNING id`,
      [nombre, email, telefono10, tipo || null, mensaje]
    );
    id = result.rows[0].id;
  } catch (error) {
    console.error('Error POST /contacto:', error.message);
    return res.status(500).json({ success: false, message: 'No pudimos enviar tu mensaje. Inténtalo de nuevo o escríbenos por WhatsApp.' });
  }

  // Ya quedó guardado: los avisos no frenan la respuesta
  res.status(201).json({ success: true, message: MENSAJE_RECIBIDO });
  avisarAlNegocio({ id, nombre, email, telefono: telefono10, tipo, mensaje }).catch((error) => {
    console.error('Contacto: error al avisar al negocio:', error.message);
  });
});

// Listar mensajes (empleado+)
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM core.tblcontacto_mensajes ORDER BY created_at DESC');
    res.json({ success: true, mensajes: result.rows });
  } catch (error) {
    console.error('Error GET /contacto:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener mensajes' });
  }
});

// Marcar como leído
router.put('/:id/leer', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    await pool.query('UPDATE core.tblcontacto_mensajes SET leido = true WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Marcado como leído' });
  } catch (error) {
    console.error('Error PUT /contacto/:id/leer:', error.message);
    res.status(500).json({ success: false, message: 'Error al marcar' });
  }
});

module.exports = router;
