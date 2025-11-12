const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

class Usuario {
  constructor(data) {
    this._id = data._id ? new ObjectId(data._id) : new ObjectId();
    this.nombre = data.nombre;
    this.apellido = data.apellido;
    this.email = data.email;
    this.password = data.password;
    this.telefono = data.telefono;
    this.rol = data.rol || 'cliente'; // cliente, empleado, gerencia, direccion_general
    this.activo = data.activo !== undefined ? data.activo : true;
    this.fechaRegistro = data.fechaRegistro || new Date();
    this.ultimoAcceso = data.ultimoAcceso || null;
    
    // Nuevos campos para verificación de email
    this.emailVerificado = data.emailVerificado || false;
    this.codigoVerificacion = data.codigoVerificacion || null;
    this.codigoVerificacionExpira = data.codigoVerificacionExpira || null;
    
    // Campos para recuperación de contraseña
    this.codigoRecuperacion = data.codigoRecuperacion || null;
    this.codigoRecuperacionExpira = data.codigoRecuperacionExpira || null;
    
    // Campo para Google OAuth
    this.googleId = data.googleId || null;
  }

  // Validar datos del usuario
  validate() {
    const errors = [];

    if (!this.nombre || this.nombre.trim().length < 2) {
      errors.push('El nombre debe tener al menos 2 caracteres');
    }

    if (!this.apellido || this.apellido.trim().length < 2) {
      errors.push('El apellido debe tener al menos 2 caracteres');
    }

    if (!this.email || !this.isValidEmail(this.email)) {
      errors.push('Email inválido');
    }

    // La contraseña no es requerida si es login con Google
    if (!this.googleId && (!this.password || this.password.length < 6)) {
      errors.push('La contraseña debe tener al menos 6 caracteres');
    }

    if (!this.telefono || this.telefono.length < 10) {
      errors.push('El teléfono debe tener al menos 10 dígitos');
    }

    const rolesValidos = ['cliente', 'empleado', 'gerencia', 'direccion_general'];
    if (!rolesValidos.includes(this.rol)) {
      errors.push('Rol inválido');
    }

    return errors;
  }

  // Validar formato de email
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  // Hashear contraseña
  async hashPassword() {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  // Comparar contraseña
  async comparePassword(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
  }

  // Generar código de verificación de 6 dígitos
  generateVerificationCode() {
    this.codigoVerificacion = Math.floor(100000 + Math.random() * 900000).toString();
    this.codigoVerificacionExpira = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
    return this.codigoVerificacion;
  }

  // Generar código de recuperación de 6 dígitos
  generateRecoveryCode() {
    this.codigoRecuperacion = Math.floor(100000 + Math.random() * 900000).toString();
    this.codigoRecuperacionExpira = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
    return this.codigoRecuperacion;
  }

  // Verificar si el código de verificación es válido
  isVerificationCodeValid(codigo) {
    return this.codigoVerificacion === codigo && 
           this.codigoVerificacionExpira && 
           new Date() < this.codigoVerificacionExpira;
  }

  // Verificar si el código de recuperación es válido
  isRecoveryCodeValid(codigo) {
    return this.codigoRecuperacion === codigo && 
           this.codigoRecuperacionExpira && 
           new Date() < this.codigoRecuperacionExpira;
  }

  // Limpiar códigos de verificación
  clearVerificationCodes() {
    this.codigoVerificacion = null;
    this.codigoVerificacionExpira = null;
  }

  // Limpiar códigos de recuperación
  clearRecoveryCodes() {
    this.codigoRecuperacion = null;
    this.codigoRecuperacionExpira = null;
  }

  // Convertir a objeto plano (sin password)
  toJSON() {
    const { password, codigoVerificacion, codigoRecuperacion, ...userWithoutSensitiveData } = this;
    return userWithoutSensitiveData;
  }

  // Convertir a objeto para base de datos
  toDocument() {
    return {
      _id: this._id,
      nombre: this.nombre,
      apellido: this.apellido,
      email: this.email.toLowerCase(),
      password: this.password,
      telefono: this.telefono,
      rol: this.rol,
      activo: this.activo,
      fechaRegistro: this.fechaRegistro,
      ultimoAcceso: this.ultimoAcceso,
      emailVerificado: this.emailVerificado,
      codigoVerificacion: this.codigoVerificacion,
      codigoVerificacionExpira: this.codigoVerificacionExpira,
      codigoRecuperacion: this.codigoRecuperacion,
      codigoRecuperacionExpira: this.codigoRecuperacionExpira,
      googleId: this.googleId
    };
  }
}

module.exports = Usuario;