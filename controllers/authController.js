const { getDB } = require('../config/database');
const Usuario = require('../models/Usuario');
const jwt = require('jsonwebtoken');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailServiceBrevo');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';

// Registrar nuevo usuario con verificación de email
async function register(req, res) {
  try {
    const { nombre, apellido, email, password, telefono, rol } = req.body;

    // Crear instancia de usuario
    const nuevoUsuario = new Usuario({
      nombre,
      apellido,
      email,
      password,
      telefono,
      rol: rol || 'cliente'
    });

    // Validar datos
    const errores = nuevoUsuario.validate();
    if (errores.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Errores de validación',
        errors: errores
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

    // Hashear contraseña
    await nuevoUsuario.hashPassword();

    // Generar código de verificación
    const codigoVerificacion = nuevoUsuario.generateVerificationCode();

    // Guardar en la base de datos
    const resultado = await db.collection('Usuarios').insertOne(nuevoUsuario.toDocument());

    // Enviar email de verificación
    try {
      await sendVerificationEmail(email, codigoVerificacion);
      console.log(`📧 Código de verificación enviado a ${email}: ${codigoVerificacion}`);
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
      // Continuamos aunque falle el email
    }

    // Respuesta exitosa
    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente. Por favor verifica tu correo electrónico.',
      email: email,
      // SOLO PARA DESARROLLO - QUITAR EN PRODUCCIÓN
      codigoVerificacion: process.env.NODE_ENV === 'development' ? codigoVerificacion : undefined
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({
      success: false,
      message: 'Error al registrar usuario',
      error: error.message
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
    console.error('Error en verificación de email:', error);
    res.status(500).json({
      success: false,
      message: 'Error al verificar email',
      error: error.message
    });
  }
}

// Reenviar código de verificación
async function resendVerificationCode(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email es requerido'
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
      console.log(`📧 Nuevo código de verificación enviado a ${email}: ${nuevoCodigoVerificacion}`);
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
    }

    res.json({
      success: true,
      message: 'Código de verificación reenviado',
      // SOLO PARA DESARROLLO
      codigoVerificacion: process.env.NODE_ENV === 'development' ? nuevoCodigoVerificacion : undefined
    });

  } catch (error) {
    console.error('Error reenviando código:', error);
    res.status(500).json({
      success: false,
      message: 'Error al reenviar código',
      error: error.message
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
    console.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error al iniciar sesión',
      error: error.message
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
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener perfil',
      error: error.message
    });
  }
}

// Solicitar recuperación de contraseña (mejorado con email)
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email es requerido'
      });
    }

    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      email: email.toLowerCase()
    });

    if (!usuarioDoc) {
      // Por seguridad, no revelamos si el email existe o no
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
      console.log(`📧 Código de recuperación enviado a ${email}: ${codigoRecuperacion}`);
    } catch (emailError) {
      console.error('Error enviando email de recuperación:', emailError);
    }

    res.json({
      success: true,
      message: 'Si el email existe, recibirás un código de recuperación',
      // SOLO PARA DESARROLLO - QUITAR EN PRODUCCIÓN
      codigo: process.env.NODE_ENV === 'development' ? codigoRecuperacion : undefined
    });

  } catch (error) {
    console.error('Error solicitando recuperación:', error);
    res.status(500).json({
      success: false,
      message: 'Error al solicitar recuperación de contraseña',
      error: error.message
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

    if (nuevaPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres'
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
    console.error('Error restableciendo contraseña:', error);
    res.status(500).json({
      success: false,
      message: 'Error al restablecer contraseña',
      error: error.message
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
  resetPassword
};