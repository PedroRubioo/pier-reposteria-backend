// models/Usuario.js
const bcrypt = require('bcryptjs');

class Usuario {
  constructor(data) {
    this.id = data.id;
    this.nombre = data.nombre;
    this.apellido = data.apellido;
    this.email = data.email;
    this.password_hash = data.password_hash;
    this.telefono = data.telefono;
    this.rol = data.rol;
    this.activo = data.activo;
    this.created_at = data.created_at;
    this.updated_at = data.updated_at;
    this.email_verificado = data.email_verificado || false;
    this.google_id = data.google_id;
    this.ultimo_acceso = data.ultimo_acceso;
  }

  // Comparar contraseña (bcrypt)
  async comparePassword(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password_hash);
  }

  // Hashear contraseña (para registro)
  static async hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
  }

  // Convertir a JSON (sin datos sensibles)
  toJSON() {
    return {
      id: this.id,
      nombre: this.nombre,
      apellido: this.apellido,
      email: this.email,
      telefono: this.telefono,
      rol: this.rol,
      activo: this.activo,
      emailVerificado: this.email_verificado,
      googleId: this.google_id,
      fechaRegistro: this.created_at,
      ultimoAcceso: this.ultimo_acceso
    };
  }

  // Buscar usuario por email
  static async findByEmail(pool, email) {
    const result = await pool.query(
      'SELECT * FROM core.tblusuarios WHERE email = $1',
      [email.toLowerCase()]
    );
    return result.rows[0] ? new Usuario(result.rows[0]) : null;
  }

  // Buscar usuario por ID
  static async findById(pool, id) {
    const result = await pool.query(
      'SELECT * FROM core.tblusuarios WHERE id = $1',
      [id]
    );
    return result.rows[0] ? new Usuario(result.rows[0]) : null;
  }

  // Crear nuevo usuario
  static async create(pool, userData) {
    const { nombre, apellido, email, password, telefono, rol = 'cliente' } = userData;
    
    const password_hash = await this.hashPassword(password);
    
    const result = await pool.query(
      `INSERT INTO core.tblusuarios 
       (nombre, apellido, email, password_hash, telefono, rol, activo, email_verificado, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [nombre, apellido, email.toLowerCase(), password_hash, telefono, rol, true, false]
    );
    
    return result.rows[0] ? new Usuario(result.rows[0]) : null;
  }

  // Actualizar último acceso
  static async updateLastAccess(pool, id) {
    await pool.query(
      'UPDATE core.tblusuarios SET ultimo_acceso = NOW() WHERE id = $1',
      [id]
    );
  }
}

module.exports = Usuario;