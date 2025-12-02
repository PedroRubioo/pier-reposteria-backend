const { getDB } = require('../config/database');
const Usuario = require('../models/Usuario');
const jwt = require('jsonwebtoken');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailServiceBrevo');
const { 
  isValidEmail, 
  isStrongPassword, 
  getPasswordRequirementsMessage,
  isValidName,
  isValidPhone,
  containsXSS,
  containsNoSQLInjection 
} = require('../middleware/validation');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';

// 🔒 SEGURIDAD: Validar y sanitizar datos de registro
function validateRegistrationData(data) {
  const errors = [];
  
  // Validar nombre
  if (!data.nombre || !isValidName(data.nombre)) {
    errors.push('El nombre debe contener solo letras y tener entre 2 y 50 caracteres');
  }
  
  // Validar apellido
  if (!data.apellido || !isValidName(data.apellido)) {
    errors.push('El apellido debe contener solo letras y tener entre 2 y 50 caracteres');
  }
  
  // Validar email
  if (!data.email || !isValidEmail(data.email)) {
    errors.push('El email no es válido');
  }
  
  // Validar contraseña fuerte
  if (!data.password) {
    errors.push('La contraseña es requerida');
  } else if (!isStrongPassword(data.password)) {
    const message = getPasswordRequirementsMessage(data.password);
    errors.push(message);
  }
  
  // Validar teléfono
  if (!data.telefono || !isValidPhone(data.telefono)) {
    errors.push('El teléfono debe tener exactamente 10 dígitos');
  }
  
  // Detectar XSS
  const fieldsToCheck = [data.nombre, data.apellido, data.email, data.telefono];
  if (fieldsToCheck.some(field => containsXSS(field))) {
    errors.push('Se detectaron caracteres no permitidos en los datos');
  }
  
  // Detectar NoSQL injection
  if (fieldsToCheck.some(field => containsNoSQLInjection(field))) {
    errors.push('Se detectaron patrones sospechosos en los datos');
  }
  
  return errors;
}

// Registrar nuevo usuario con verificación de email
async function register(req, res) {
  try {
    const { nombre, apellido, email, password, telefono, rol } = req.body;

    // 🔒 VALIDACIÓN DE SEGURIDAD
    const validationErrors = validateRegistrationData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Errores de validación',
        errors: validationErrors
      });
    }

    // Verificar si el email ya existe
    const db = await getDB();
    const usuarioExistente = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (usuarioExistente) {
      return res.status(400).json({
        success: false,
        message: 'El email ya está registrado'
      });
    }

    // Crear instancia de usuario
    const nuevoUsuario = new Usuario({
      nombre,
      apellido,
      email,
      password,
      telefono,
      rol: rol || 'cliente'
    });

    // Hashear contraseña
    await nuevoUsuario.hashPassword();

    // Generar código de verificación
    const codigoVerificacion = nuevoUsuario.generateVerificationCode();

    // Guardar en la base de datos
    const resultado = await db.collection('Usuarios').insertOne(nuevoUsuario.toDocument());

    // Enviar email de verificación
    try {
      await sendVerificationEmail(email, codigoVerificacion);
      console.log(`✅ Código de verificación enviado a ${email}`);
    } catch (emailError) {
      console.error('❌ Error enviando email:', emailError.message);
      // Continuamos aunque falle el email
    }

    // Respuesta exitosa (NO incluir código en producción)
    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente. Por favor verifica tu correo electrónico.',
      email: email
    });

  } catch (error) {
    console.error('❌ Error en registro:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al registrar usuario'
    });
  }
}

// Verificar email con código
async function verifyEmail(req, res) {
  try {
    const { email, codigo } = req.body;

    if (!email || !codigo) {
      return res.status(400).json({
        success: false,
        message: 'Email y código son requeridos'
      });
    }

    // 🔒 Validar formato de email
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email no válido'
      });
    }

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (!usuarioDoc) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    const usuario = new Usuario(usuarioDoc);

    // Verificar si ya está verificado
    if (usuario.emailVerificado) {
      return res.status(400).json({
        success: false,
        message: 'El email ya está verificado'
      });
    }

    // Verificar código
    if (!usuario.isVerificationCodeValid(codigo)) {
      return res.status(400).json({
        success: false,
        message: 'Código inválido o expirado'
      });
    }

    // Marcar como verificado y limpiar códigos
    await db.collection('Usuarios').updateOne(
      { email: email.toLowerCase() },
      {
        $set: { emailVerificado: true },
        $unset: { codigoVerificacion: '', codigoVerificacionExpira: '' }
      }
    );

    // Generar token JWT
    const token = jwt.sign(
      { userId: usuario._id, email: usuario.email, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Email verificado exitosamente',
      token,
      user: usuario.toJSON()
    });

  } catch (error) {
    console.error('❌ Error en verificación de email:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al verificar email'
    });
  }
}

// Reenviar código de verificación
async function resendVerificationCode(req, res) {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email válido es requerido'
      });
    }

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (!usuarioDoc) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    const usuario = new Usuario(usuarioDoc);

    if (usuario.emailVerificado) {
      return res.status(400).json({
        success: false,
        message: 'El email ya está verificado'
      });
    }

    // Generar nuevo código
    const nuevoCodigoVerificacion = usuario.generateVerificationCode();

    // Actualizar en base de datos
    await db.collection('Usuarios').updateOne(
      { email: email.toLowerCase() },
      {
        $set: {
          codigoVerificacion: usuario.codigoVerificacion,
          codigoVerificacionExpira: usuario.codigoVerificacionExpira
        }
      }
    );

    // Enviar email
    try {
      await sendVerificationEmail(email, nuevoCodigoVerificacion);
      console.log(`✅ Nuevo código enviado a ${email}`);
    } catch (emailError) {
      console.error('❌ Error enviando email:', emailError.message);
    }

    res.json({
      success: true,
      message: 'Código de verificación reenviado'
    });

  } catch (error) {
    console.error('❌ Error reenviando código:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al reenviar código'
    });
  }
}

// Iniciar sesión (actualizado para verificar email)
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y contraseña son requeridos'
      });
    }

    // 🔒 Validar email
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email no válido'
      });
    }

    // Buscar usuario
    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (!usuarioDoc) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    // Crear instancia de usuario
    const usuario = new Usuario(usuarioDoc);

    // Verificar si el email está verificado
    if (!usuario.emailVerificado) {
      return res.status(401).json({
        success: false,
        message: 'Por favor verifica tu correo electrónico antes de iniciar sesión',
        needsVerification: true,
        email: usuario.email
      });
    }

    // Verificar si está activo
    if (!usuario.activo) {
      return res.status(403).json({
        success: false,
        message: 'Usuario inactivo. Contacta al administrador.'
      });
    }

    // Comparar contraseña
    const passwordValido = await usuario.comparePassword(password);
    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    // Actualizar último acceso
    await db.collection('Usuarios').updateOne(
      { _id: usuario._id },
      { $set: { ultimoAcceso: new Date() } }
    );

    // Generar token JWT
    const token = jwt.sign(
      { userId: usuario._id, email: usuario.email, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Respuesta exitosa
    res.json({
      success: true,
      message: 'Inicio de sesión exitoso',
      user: usuario.toJSON(),
      token
    });

  } catch (error) {
    console.error('❌ Error en login:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al iniciar sesión'
    });
  }
}

// Obtener usuario actual
async function getProfile(req, res) {
  try {
    const userId = req.user.userId;

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      _id: new require('mongodb').ObjectId(userId)
    });

    if (!usuarioDoc) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    const usuario = new Usuario(usuarioDoc);

    res.json({
      success: true,
      user: usuario.toJSON()
    });

  } catch (error) {
    console.error('❌ Error obteniendo perfil:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al obtener perfil'
    });
  }
}

// Solicitar recuperación de contraseña (mejorado con email)
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email válido es requerido'
      });
    }

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    // 🔒 SEGURIDAD: No revelar si el usuario existe
    if (!usuarioDoc) {
      return res.json({
        success: true,
        message: 'Si el email existe, recibirás un código de recuperación'
      });
    }

    const usuario = new Usuario(usuarioDoc);

    // Generar código de recuperación
    const codigoRecuperacion = usuario.generateRecoveryCode();

    // Guardar código en la base de datos
    await db.collection('Usuarios').updateOne(
      { email: email.toLowerCase() },
      {
        $set: {
          codigoRecuperacion: usuario.codigoRecuperacion,
          codigoRecuperacionExpira: usuario.codigoRecuperacionExpira
        }
      }
    );

    // Enviar email con el código
    try {
      await sendPasswordResetEmail(email, codigoRecuperacion);
      console.log(`✅ Código de recuperación enviado a ${email}`);
    } catch (emailError) {
      console.error('❌ Error enviando email de recuperación:', emailError.message);
    }

    res.json({
      success: true,
      message: 'Si el email existe, recibirás un código de recuperación'
    });

  } catch (error) {
    console.error('❌ Error solicitando recuperación:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al solicitar recuperación de contraseña'
    });
  }
}

// Restablecer contraseña
async function resetPassword(req, res) {
  try {
    const { email, codigo, nuevaPassword } = req.body;

    if (!email || !codigo || !nuevaPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, código y nueva contraseña son requeridos'
      });
    }

    // 🔒 Validar email
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email no válido'
      });
    }

    // 🔒 Validar contraseña fuerte
    if (!isStrongPassword(nuevaPassword)) {
      const message = getPasswordRequirementsMessage(nuevaPassword);
      return res.status(400).json({
        success: false,
        message: message
      });
    }

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (!usuarioDoc) {
      return res.status(400).json({
        success: false,
        message: 'Código inválido o expirado'
      });
    }

    const usuario = new Usuario(usuarioDoc);

    // Verificar código
    if (!usuario.isRecoveryCodeValid(codigo)) {
      return res.status(400).json({
        success: false,
        message: 'Código inválido o expirado'
      });
    }

    // Actualizar contraseña
    usuario.password = nuevaPassword;
    await usuario.hashPassword();

    // Actualizar en base de datos y limpiar código
    await db.collection('Usuarios').updateOne(
      { email: email.toLowerCase() },
      {
        $set: { password: usuario.password },
        $unset: { codigoRecuperacion: '', codigoRecuperacionExpira: '' }
      }
    );

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('❌ Error restableciendo contraseña:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al restablecer contraseña'
    });
  }
}

// 🔒 Cerrar sesión e invalidar token
async function logout(req, res) {
  try {
    const token = req.token; // Viene del middleware verifyToken
    const { tokenBlacklist } = require('../middleware/tokenBlacklist');
    const jwt = require('jsonwebtoken');

    // Decodificar token para obtener expiración
    const decoded = jwt.decode(token);
    const expiresAt = decoded.exp * 1000; // Convertir a milliseconds

    // Agregar token a la blacklist
    tokenBlacklist.add(token, expiresAt);

    res.json({
      success: true,
      message: 'Sesión cerrada exitosamente'
    });

  } catch (error) {
    console.error('❌ Error en logout:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error al cerrar sesión'
    });
  }
}

module.exports = {
  register,
  verifyEmail,
  resendVerificationCode,
  login,
  getProfile,
  requestPasswordReset,
  resetPassword,
  logout // ✅ NUEVO
};