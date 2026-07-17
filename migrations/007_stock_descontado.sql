-- =====================================================================
-- MIGRACIÓN 007: Registro del stock descontado por línea de pedido
-- Al cancelar o rechazar un pedido, el inventario descontado se repone.
-- Sin este registro no se puede saber cuánto devolver: los items "sin
-- stock" de pedidos por confirmar no descuentan nada, y el descuento
-- con tope en cero puede ser parcial.
-- Los pedidos históricos quedan en 0 (no se puede inferir su descuento
-- real): cancelarlos no repone stock, igual que antes de esta migración.
-- Ejecutar en Neon SQL Editor de forma completa.
-- =====================================================================

BEGIN;

ALTER TABLE core.tblpedido_items
  ADD COLUMN IF NOT EXISTS stock_descontado INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN core.tblpedido_items.stock_descontado IS
  'Unidades realmente descontadas del inventario al crear el pedido; se repone (y se pone en 0) al cancelar/rechazar.';

COMMIT;

-- VERIFICACIÓN:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='core' AND table_name='tblpedido_items' AND column_name='stock_descontado';
