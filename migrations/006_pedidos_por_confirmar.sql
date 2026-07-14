-- =====================================================================
-- MIGRACIÓN 006: Pedidos programados "por confirmar"
-- Un pedido pickup con fecha de recogida FUTURA puede pagarse aunque
-- algún producto no tenga stock hoy: queda marcado por_confirmar y el
-- personal lo aprueba (lo tendrán para esa fecha) o lo rechaza (se
-- cancela y se genera la solicitud de reembolso automáticamente).
-- Ejecutar en Neon SQL Editor de forma completa.
-- =====================================================================

BEGIN;

ALTER TABLE core.tblpedidos
  ADD COLUMN IF NOT EXISTS por_confirmar BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN core.tblpedidos.por_confirmar IS
  'Pedido programado con productos sin stock actual: requiere aprobación del personal antes de producirse.';

COMMIT;

-- VERIFICACIÓN:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='core' AND table_name='tblpedidos' AND column_name='por_confirmar';
