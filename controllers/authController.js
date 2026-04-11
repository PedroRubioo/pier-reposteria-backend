// controllers/authController.js — MIGRADO A POSTGRESQL (corregido al schema real)
const { pool } = require('../config/database');
const Usuario = require('../models/Usuario');
const jwt = require('jsonwebtoken');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailServiceBrevo');
const { isValidEmail, isStrongPassword, getPasswordRequirementsMessage, isValidName, isValidPhone, containsXSS, containsNoSQLInjection } = require('../middleware/validation');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';
const { tokenBlacklist } = require('../middleware/tokenBlacklist');
const { SecureLogger } = require('../utils/secureLogger');

function validateRegistrationData(data) {
  const errors = [];
  if (!data.nombre || !isValidName(data.nombre)) errors.push('El nombre debe contener solo letras y tener entre 2 y 50 caracteres');
  if (!data.apellido || !isValidName(data.apellido)) errors.push('El apellido debe contener solo letras y tener entre 2 y 50 caracteres');
  if (!data.email || !isValidEmail(data.email)) errors.push('El email no es válido');
  if (!data.password) errors.push('La contraseña es requerida');
  else if (!isStrongPassword(data.password)) errors.push(getPasswordRequirementsMessage(data.password));
  if (!data.telefono || !isValidPhone(data.telefono)) errors.push('El teléfono debe tener exactamente 10 dígitos');
  const fields = [data.nombre, data.apellido, data.email, data.telefono];
  if (fields.some(f => containsXSS(f))) errors.push('Se detectaron caracteres no permitidos');
  if (fields.some(f => containsNoSQLInjection(f))) errors.push('Se detectaron patrones sospechosos');
  return errors;
}

function generarCodigo6Digitos() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── REGISTRO ──
async function register(req, res) {
  try {
    const { nombre, apellido, email, password, telefono, rol } = req.body;
    const validationErrors = validateRegistrationData(req.body);
    if (validationErrors.length > 0) return res.status(400).json({ success: false, message: 'Errores de validación', errors: validationErrors });

    const existente = await pool.query('SELECT id FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (existente.rows.length > 0) return res.status(400).json({ success: false, message: 'El email ya está registrado' });

    const password_hash = await Usuario.hashPassword(password);
    const resultado = await pool.query(
      `INSERT INTO core.tblusuarios (nombre, apellido, email, password_hash, telefono, rol, activo, email_verificado, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,false,NOW(),NOW()) RETURNING id, email`,
      [nombre, apellido, email.toLowerCase(), password_hash, telefono, rol || 'cliente']
    );
    const nuevoUsuario = resultado.rows[0];

    const codigo = generarCodigo6Digitos();
    const expiraAt = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      `INSERT INTO core.tblcodigos_verificacion (usuario_id, email, codigo, tipo, usado, expira_at, created_at)
       VALUES ($1, $2, $3, 'registro', false, $4, NOW())`,
      [nuevoUsuario.id, email.toLowerCase(), codigo, expiraAt]
    );

    try { await sendVerificationEmail(email, codigo); console.log(`✅ Código enviado a ${email}`); }
    catch (e) { console.error('❌ Error enviando email:', e.message); }

    res.status(201).json({ success: true, message: 'Usuario registrado. Verifica tu correo electrónico.', email });
  } catch (error) {
    console.error('❌ Error en registro:', error.message);
    res.status(500).json({ success: false, message: 'Error al registrar usuario' });
  }
}

// ── VERIFICAR EMAIL ──
async function verifyEmail(req, res) {
  try {
    const { email, codigo } = req.body;
    if (!email || !codigo) return res.status(400).json({ success: false, message: 'Email y código son requeridos' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Email no válido' });

    const userResult = await pool.query('SELECT * FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const usuarioDoc = userResult.rows[0];
    if (usuarioDoc.email_verificado) return res.status(400).json({ success: false, message: 'El email ya está verificado' });

    const codigoResult = await pool.query(
      `SELECT id FROM core.tblcodigos_verificacion
       WHERE email = $1 AND codigo = $2 AND tipo = 'registro' AND usado = false AND expira_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase(), codigo]
    );
    if (codigoResult.rows.length === 0) return res.status(400).json({ success: false, message: 'Código inválido o expirado' });

    await pool.query('UPDATE core.tblcodigos_verificacion SET usado = true WHERE id = $1', [codigoResult.rows[0].id]);
    await pool.query('UPDATE core.tblusuarios SET email_verificado = true, updated_at = NOW() WHERE id = $1', [usuarioDoc.id]);

    // Notificación de bienvenida + email
    const { notificarConEmail } = require('../services/notificacionHelper');
    await notificarConEmail({
      usuario_id: usuarioDoc.id,
      tipo: 'sistema',
      titulo: '¡Bienvenido a Pier Repostería!',
      mensaje: `Hola ${usuarioDoc.nombre}, tu cuenta ha sido verificada. Ya puedes explorar nuestros productos y hacer pedidos.`,
      email: usuarioDoc.email,
      nombre: usuarioDoc.nombre,
      asunto: '🍰 ¡Bienvenido a Pier Repostería!',
      contenidoHtml: `
        <h2>¡Bienvenido, ${usuarioDoc.nombre}!</h2>
        <p>Tu cuenta ha sido verificada exitosamente. Ahora puedes:</p>
        <div class="highlight-box">
          <p><strong>✅ Explorar</strong> nuestro catálogo de productos artesanales</p>
          <p><strong>🛒 Hacer pedidos</strong> y pagar en línea</p>
          <p><strong>🏪 Recoger</strong> en nuestra sucursal de Huejutla de Reyes</p>
          <p><strong>⭐ Dejar reseñas</strong> sobre tus productos favoritos</p>
        </div>
        <p>¡Esperamos endulzar tus momentos!</p>
      `
    });

    const token = jwt.sign({ userId: usuarioDoc.id, email: usuarioDoc.email, rol: usuarioDoc.rol }, JWT_SECRET, { expiresIn: '7d' });
    const usuario = new Usuario(usuarioDoc);

    res.json({ success: true, message: 'Email verificado exitosamente', token, user: usuario.toJSON() });
  } catch (error) {
    console.error('❌ Error verificando email:', error.message);
    res.status(500).json({ success: false, message: 'Error al verificar email' });
  }
}

// ── REENVIAR CÓDIGO ──
async function resendVerificationCode(req, res) {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Email válido es requerido' });

    const userResult = await pool.query('SELECT id, email_verificado FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (userResult.rows[0].email_verificado) return res.status(400).json({ success: false, message: 'El email ya está verificado' });

    await pool.query(`UPDATE core.tblcodigos_verificacion SET usado = true WHERE email = $1 AND tipo = 'registro' AND usado = false`, [email.toLowerCase()]);

    const codigo = generarCodigo6Digitos();
    const expiraAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      `INSERT INTO core.tblcodigos_verificacion (usuario_id, email, codigo, tipo, usado, expira_at, created_at)
       VALUES ($1, $2, $3, 'registro', false, $4, NOW())`,
      [userResult.rows[0].id, email.toLowerCase(), codigo, expiraAt]
    );

    try { await sendVerificationEmail(email, codigo); } catch (e) { console.error('❌ Error email:', e.message); }
    res.json({ success: true, message: 'Código reenviado' });
  } catch (error) {
    console.error('❌ Error reenviando:', error.message);
    res.status(500).json({ success: false, message: 'Error al reenviar código' });
  }
}

// ── LOGIN ──
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Email no válido' });

    const userResult = await pool.query('SELECT * FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

    const usuarioDoc = userResult.rows[0];
    const usuario = new Usuario(usuarioDoc);

    if (!usuario.email_verificado) return res.status(401).json({ success: false, message: 'Verifica tu correo antes de iniciar sesión', needsVerification: true, email: usuario.email });
    if (!usuario.activo) return res.status(403).json({ success: false, message: 'Usuario inactivo. Contacta al administrador.' });

    const passwordValido = await usuario.comparePassword(password);
    if (!passwordValido) return res.status(401).json({ success: false, message: 'Credenciales inválidas' });

    await pool.query('UPDATE core.tblusuarios SET ultimo_acceso = NOW() WHERE id = $1', [usuarioDoc.id]);

    const token = jwt.sign({ userId: usuarioDoc.id, email: usuarioDoc.email, rol: usuarioDoc.rol }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, message: 'Inicio de sesión exitoso', user: usuario.toJSON(), token });
  } catch (error) {
    console.error('❌ Error en login:', error.message);
    res.status(500).json({ success: false, message: 'Error al iniciar sesión' });
  }
}

// ── PERFIL ──
async function getProfile(req, res) {
  try {
    const userResult = await pool.query('SELECT * FROM core.tblusuarios WHERE id = $1', [req.user.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, user: new Usuario(userResult.rows[0]).toJSON() });
  } catch (error) {
    console.error('❌ Error perfil:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener perfil' });
  }
}

// ── SOLICITAR RECUPERACIÓN ──
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Email válido es requerido' });

    const userResult = await pool.query('SELECT id FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.json({ success: true, message: 'Si el email existe, recibirás un código' });

    await pool.query(`UPDATE core.tblcodigos_verificacion SET usado = true WHERE email = $1 AND tipo = 'recuperacion' AND usado = false`, [email.toLowerCase()]);

    const codigo = generarCodigo6Digitos();
    const expiraAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      `INSERT INTO core.tblcodigos_verificacion (usuario_id, email, codigo, tipo, usado, expira_at, created_at)
       VALUES ($1, $2, $3, 'recuperacion', false, $4, NOW())`,
      [userResult.rows[0].id, email.toLowerCase(), codigo, expiraAt]
    );

    try { await sendPasswordResetEmail(email, codigo); } catch (e) { console.error('❌ Error email:', e.message); }
    res.json({ success: true, message: 'Si el email existe, recibirás un código' });
  } catch (error) {
    console.error('❌ Error recuperación:', error.message);
    res.status(500).json({ success: false, message: 'Error al solicitar recuperación' });
  }
}

// ── RESTABLECER CONTRASEÑA ──
async function resetPassword(req, res) {
  try {
    const { email, codigo, nuevaPassword } = req.body;
    if (!email || !codigo || !nuevaPassword) return res.status(400).json({ success: false, message: 'Email, código y nueva contraseña son requeridos' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Email no válido' });
    if (!isStrongPassword(nuevaPassword)) return res.status(400).json({ success: false, message: getPasswordRequirementsMessage(nuevaPassword) });

    const userResult = await pool.query('SELECT id FROM core.tblusuarios WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(400).json({ success: false, message: 'Código inválido o expirado' });

    const codigoResult = await pool.query(
      `SELECT id FROM core.tblcodigos_verificacion
       WHERE email = $1 AND codigo = $2 AND tipo = 'recuperacion' AND usado = false AND expira_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase(), codigo]
    );
    if (codigoResult.rows.length === 0) return res.status(400).json({ success: false, message: 'Código inválido o expirado' });

    await pool.query('UPDATE core.tblcodigos_verificacion SET usado = true WHERE id = $1', [codigoResult.rows[0].id]);
    const password_hash = await Usuario.hashPassword(nuevaPassword);
    await pool.query('UPDATE core.tblusuarios SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, userResult.rows[0].id]);

    // Notificar por email que la contraseña fue cambiada
    try {
      const { enviarEmailNotificacion } = require('../services/notificacionHelper');
      await enviarEmailNotificacion({
        email: email.toLowerCase(),
        nombre: '',
        asunto: 'Contraseña actualizada - Pier Repostería',
        contenido: `<h2>🔐 Contraseña Actualizada</h2><p>Tu contraseña fue actualizada exitosamente el <strong>${new Date().toLocaleString('es-MX')}</strong>.</p><div class="highlight-box"><strong>⚠️ Si tú no realizaste este cambio</strong>, contacta al soporte de inmediato respondiendo a este correo.</div>`
      });
    } catch (emailErr) {
      console.error('Error enviando notificación de cambio de contraseña:', emailErr.message);
    }

    res.json({ success: true, message: 'Contraseña actualizada exitosamente' });
  } catch (error) {
    console.error('❌ Error restableciendo:', error.message);
    res.status(500).json({ success: false, message: 'Error al restablecer contraseña' });
  }
}

// ── LOGOUT ──
const logout = async (req, res) => {
  try {
    const token = req.token;
    const user = req.user;
    tokenBlacklist.add(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
    SecureLogger.auth('Logout', user.email, true, { userId: user.userId, rol: user.rol, ip: req.ip });
    res.json({ success: true, message: 'Sesión cerrada exitosamente' });
  } catch (error) {
    SecureLogger.error('Error en logout', error);
    res.status(500).json({ success: false, message: 'Error al cerrar sesión' });
  }
};

module.exports = { register, verifyEmail, resendVerificationCode, login, getProfile, requestPasswordReset, resetPassword, logout };