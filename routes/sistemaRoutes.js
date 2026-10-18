// routes/sistemaRoutes.js — Estado del sistema (Diseno_Panel_Direccion.md §4.3)
//
// Solo Dirección general, con el rol leído de la base. Dice con palabras
// claras si cada servicio está listo. Nunca devuelve llaves: de cada
// variable solo se mira si existe y, de la de Stripe, su prefijo.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { pool } = require('../config/database');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { diaHuejutla, horaHuejutla, sumarDias } = require('../utils/fechasHuejutla');

// El mismo repositorio de respaldos que routes/backupRoutes.js
const GITHUB_REPO = 'PedroRubioo/pier-reposteria';
// Plan de Neon: 512 MB si no se configura otro límite
const LIMITE_MB = Number(process.env.BD_LIMITE_MB) > 0 ? Number(process.env.BD_LIMITE_MB) : 512;
const LATENCIA_LENTA_MS = 1000;
const USO_ALTO = 0.8;
const HORAS_RESPALDO_VIGENTE = 48;

const configurada = (valor) => typeof valor === 'string' && valor.trim() !== '';
const mb = (bytes) => Math.round((bytes / 1048576) * 100) / 100;

async function revisarBase() {
  try {
    const inicio = Date.now();
    await pool.query('SELECT 1');
    const latencia = Date.now() - inicio;
    const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
    const tamano = mb(Number(rows[0].bytes));
    const lenta = latencia >= LATENCIA_LENTA_MS;
    const llena = tamano >= LIMITE_MB * USO_ALTO;
    let resumen = 'Funcionando';
    if (lenta) resumen = 'Responde lento';
    else if (llena) resumen = 'Queda poco espacio';
    return {
      servicio: {
        estado: lenta || llena ? 'atencion' : 'ok',
        detalle: `${resumen}: contesta en ${latencia} ms y usa ${tamano} MB de ${LIMITE_MB} MB`,
      },
      tamano,
    };
  } catch (error) {
    console.error('Estado del sistema, base de datos:', error.message);
    return { servicio: { estado: 'error', detalle: 'La base de datos no responde' }, tamano: null };
  }
}

function revisarCobros() {
  const llave = process.env.STRIPE_SECRET_KEY || '';
  if (/^(sk|rk)_live_/.test(llave)) return { estado: 'ok', detalle: 'Modo real: los pagos con tarjeta cobran dinero de verdad' };
  if (/^(sk|rk)_test_/.test(llave)) return { estado: 'atencion', detalle: 'Modo de prueba: los pagos no cobran dinero real' };
  if (configurada(llave)) return { estado: 'atencion', detalle: 'La llave de cobros no tiene un formato reconocido' };
  return { estado: 'error', detalle: 'Sin configurar: la tienda no puede recibir pagos' };
}

function revisarCorreo() {
  return configurada(process.env.BREVO_API_KEY) && configurada(process.env.BREVO_SENDER_EMAIL)
    ? { estado: 'ok', detalle: 'Configurado: salen los códigos de verificación y los avisos' }
    : { estado: 'error', detalle: 'Sin configurar: no salen códigos de verificación ni avisos por correo' };
}

function revisarImagenes() {
  return [process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET].every(configurada)
    ? { estado: 'ok', detalle: 'Configurado: se pueden subir fotos' }
    : { estado: 'error', detalle: 'Sin configurar: no se pueden subir fotos' };
}

/** "hoy 00:00", "ayer 00:00" o "15/10/2026 00:00", en hora de Huejutla */
function cuando(instante) {
  const dia = diaHuejutla(instante);
  const hoy = diaHuejutla();
  const hora = horaHuejutla(instante);
  if (dia === hoy) return `hoy ${hora}`;
  if (dia === sumarDias(hoy, -1)) return `ayer ${hora}`;
  const [anio, mes, d] = dia.split('-');
  return `${d}/${mes}/${anio} ${hora}`;
}

async function revisarRespaldos() {
  if (!configurada(process.env.GITHUB_TOKEN)) {
    return { estado: 'atencion', detalle: 'Falta conectar los respaldos automáticos: no se puede saber cuándo fue el último' };
  }
  try {
    const { data } = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts?per_page=100`, {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
      timeout: 8000,
    });
    const fechas = data.artifacts
      .filter(a => a.name.startsWith('neon-backup') && !a.expired)
      .map(a => new Date(a.created_at).getTime());
    if (fechas.length === 0) return { estado: 'atencion', detalle: 'No hay respaldos guardados' };
    const ultimo = Math.max(...fechas);
    const vigente = Date.now() - ultimo <= HORAS_RESPALDO_VIGENTE * 3600000;
    return { estado: vigente ? 'ok' : 'atencion', detalle: `Último respaldo: ${cuando(new Date(ultimo))}` };
  } catch (error) {
    console.error('Estado del sistema, respaldos:', error.message);
    return { estado: 'error', detalle: 'No se pudo consultar los respaldos' };
  }
}

router.get('/estado', accesoVigente(['direccion_general']), async (req, res) => {
  try {
    const [base, respaldos] = await Promise.all([revisarBase(), revisarRespaldos()]);
    res.json({
      success: true,
      servicios: [
        { clave: 'base_datos', etiqueta: 'Base de datos', ...base.servicio },
        { clave: 'cobros', etiqueta: 'Cobros', ...revisarCobros() },
        { clave: 'correo', etiqueta: 'Correos', ...revisarCorreo() },
        { clave: 'imagenes', etiqueta: 'Imágenes', ...revisarImagenes() },
        { clave: 'respaldos', etiqueta: 'Respaldos', ...respaldos },
      ],
      base: { tamano_mb: base.tamano, limite_mb: LIMITE_MB },
    });
  } catch (error) {
    console.error('Error GET /sistema/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al revisar el estado del sistema' });
  }
});

module.exports = router;
