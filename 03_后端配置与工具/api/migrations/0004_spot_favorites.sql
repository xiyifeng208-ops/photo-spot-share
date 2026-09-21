-- 收藏即想去清单；关系独立于作品公开状态，作品恢复公开后仍可找回。
CREATE TABLE IF NOT EXISTS spot_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  -- 游标采用 JavaScript ISO 时间，毫秒精度防止分页时截断微秒漏项。
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, spot_id)
);

CREATE INDEX IF NOT EXISTS spot_favorites_user_created_idx
  ON spot_favorites (user_id, created_at DESC, spot_id DESC);
CREATE INDEX IF NOT EXISTS spot_favorites_spot_idx ON spot_favorites (spot_id);
