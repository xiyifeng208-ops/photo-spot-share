-- 固定选项近期反馈，始终是未经核实的用户信息；不改变作品状态。
CREATE TABLE IF NOT EXISTS spot_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('still_accessible', 'location_changed', 'access_restricted', 'obstructed')),
  -- 与 ISO 游标一致的毫秒精度，避免分页截断微秒。
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (user_id, spot_id)
);
CREATE INDEX IF NOT EXISTS spot_conditions_spot_updated_idx
  ON spot_conditions (spot_id, updated_at DESC, id DESC);

