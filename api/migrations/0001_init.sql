-- 旅游拍照机位打卡分享 —— 初始化结构
-- 坐标系说明：全部字段存储 GCJ-02（火星坐标）经纬度，与微信小程序地图底图一致。
-- geography(Point,4326) 只是"容器"，语义上装的是 GCJ-02 数值，不做 WGS-84 转换。

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE spot_status AS ENUM ('active', 'hidden', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE spot_heading AS ENUM ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE spot_best_time AS ENUM ('sunrise', 'morning', 'noon', 'afternoon', 'sunset', 'blue_hour', 'night');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE spot_season AS ENUM ('spring', 'summer', 'autumn', 'winter');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE spot_focal_length AS ENUM ('ultrawide', 'standard', 'tele', 'macro', 'drone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid      text NOT NULL UNIQUE,
  nickname    text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  location      geography(Point, 4326) NOT NULL,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  province      text,
  city          text,
  district      text,
  address       text,
  heading       spot_heading,
  best_times    spot_best_time[] NOT NULL DEFAULT '{}',
  best_seasons  spot_season[] NOT NULL DEFAULT '{}',
  focal_length  spot_focal_length,
  difficulty    smallint NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
  access_note   text,
  cover_photo_id uuid,
  status        spot_status NOT NULL DEFAULT 'active',
  view_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spots_location_gix ON spots USING GIST (location);
CREATE INDEX IF NOT EXISTS spots_city_idx ON spots (city);
CREATE INDEX IF NOT EXISTS spots_created_at_idx ON spots (created_at DESC);
CREATE INDEX IF NOT EXISTS spots_user_idx ON spots (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS spots_status_idx ON spots (status);

CREATE TABLE IF NOT EXISTS photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id     uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  mime        text,
  size_bytes  bigint,
  width       integer,
  height      integer,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photos_spot_idx ON photos (spot_id, sort_order);
CREATE INDEX IF NOT EXISTS photos_object_key_idx ON photos (object_key);

ALTER TABLE spots
  DROP CONSTRAINT IF EXISTS spots_cover_photo_fk;
ALTER TABLE spots
  ADD CONSTRAINT spots_cover_photo_fk
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL;

-- 上传票据：签发直传凭证时落库，发布打卡点后回填 spot_id。
-- 未被引用的票据（spot_id IS NULL）超过 24 小时由定时任务清理，同时删除对象存储里的孤儿文件。
CREATE TABLE IF NOT EXISTS upload_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key   text NOT NULL UNIQUE,
  mime         text,
  size_bytes   bigint,
  width        integer,
  height       integer,
  spot_id      uuid REFERENCES spots(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz
);

CREATE INDEX IF NOT EXISTS upload_tickets_gc_idx ON upload_tickets (created_at) WHERE spot_id IS NULL;
CREATE INDEX IF NOT EXISTS upload_tickets_user_idx ON upload_tickets (user_id, created_at DESC);

