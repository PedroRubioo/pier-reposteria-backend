# 🍰 Pier Repostería - Backend API

Backend para la aplicación web de Pier Repostería.

## 🚀 Despliegue en Render

1. Conectar repositorio en Render
2. Configurar variables de entorno
3. Deploy automático

## 🔧 Variables de Entorno

- `MONGODB_URI` - Conexión a MongoDB Atlas
- `JWT_SECRET` - Clave para tokens JWT  
- `EMAIL_USER` - Email para notificaciones
- `EMAIL_PASSWORD` - Contraseña de aplicación Gmail
- `NODE_ENV` - Ambiente (production/development)

## 📊 Health Checks

- `GET /api/health` - Estado básico
- `GET /api/health/ready` - Estado con verificación de BD