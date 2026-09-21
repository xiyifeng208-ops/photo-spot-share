-- 内容安全与举报处置

-- 机审任务：新机位发布后提交微信 media_check_async，用 trace_id 轮询结果。
CREATE TABLE IF NOT EXISTS content_check_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id     uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  trace_id    text,
  status      text NOT NULL DEFAULT 'pending',  -- pending | pass | risky | failed
  attempts    integer NOT NULL DEFAULT 0,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_check_tasks_poll_idx
  ON content_check_tasks (status, created_at)
  WHERE status = 'pending';

-- 举报：同一用户对同一机位只能举报一次
CREATE TABLE IF NOT EXISTS spot_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id      uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       text NOT NULL,
  detail       text,
  status       text NOT NULL DEFAULT 'open',   -- open | resolved | rejected
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spot_reports_once UNIQUE (spot_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS spot_reports_spot_idx ON spot_reports (spot_id);
CREATE INDEX IF NOT EXISTS spot_reports_status_idx ON spot_reports (status, created_at DESC);

