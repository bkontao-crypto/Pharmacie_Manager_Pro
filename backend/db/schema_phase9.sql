-- Phase 9 : réception partielle des transferts de stock (idempotent)
-- Le destinataire indique, lot par lot, la quantité réellement reçue ; l'écart reste « en transit » jusqu'à sa reprise par l'expéditrice.

ALTER TABLE stock_transfer_lots ADD COLUMN IF NOT EXISTS received_quantity int CHECK (received_quantity >= 0);   -- NULL tant que non réceptionné
ALTER TABLE stock_transfer_lots DROP CONSTRAINT IF EXISTS stock_transfer_lots_received_ok;
ALTER TABLE stock_transfer_lots ADD CONSTRAINT stock_transfer_lots_received_ok CHECK (received_quantity IS NULL OR received_quantity <= quantity);
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS shortfall_units int NOT NULL DEFAULT 0 CHECK (shortfall_units >= 0);   -- unités manquantes à la réception
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS shortfall_settled_at timestamptz;                                   -- écart repris par l'expéditrice

ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft','in_transit','received','received_short','cancelled','refused','returned'));
