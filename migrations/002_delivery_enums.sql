-- =====================================================================
-- MIGRACIÓN 002: Valores de ENUM para envío a domicilio
-- El esquema real de Neon usa ENUMs de PostgreSQL (public.rol_usuario,
-- public.estado_pedido, public.tipo_notificacion) que la migración 001
-- no contemplaba. Sin estos valores, cambiar un usuario a repartidor o
-- mover un pedido a estados de entrega truena con 500.
-- NOTA: ALTER TYPE ... ADD VALUE no va dentro de BEGIN/COMMIT.
-- Ejecutar en Neon SQL Editor tal cual.
-- =====================================================================

ALTER TYPE public.rol_usuario ADD VALUE IF NOT EXISTS 'repartidor';

ALTER TYPE public.estado_pedido ADD VALUE IF NOT EXISTS 'asignado';
ALTER TYPE public.estado_pedido ADD VALUE IF NOT EXISTS 'en_camino';
ALTER TYPE public.estado_pedido ADD VALUE IF NOT EXISTS 'entregado';
ALTER TYPE public.estado_pedido ADD VALUE IF NOT EXISTS 'entrega_fallida';

ALTER TYPE public.tipo_notificacion ADD VALUE IF NOT EXISTS 'alerta';

-- =====================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =====================================================================
-- SELECT t.typname, e.enumlabel
--   FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
--  WHERE t.typname IN ('rol_usuario', 'estado_pedido', 'tipo_notificacion')
--  ORDER BY t.typname, e.enumsortorder;
