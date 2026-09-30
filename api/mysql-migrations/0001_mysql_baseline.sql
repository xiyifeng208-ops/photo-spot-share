-- Photo Spot Share: MySQL baseline (8.4 target).
-- Run only in an EMPTY project database selected by the client.
-- Configure the client to STOP ON ERROR. Do not use --force.
-- This file contains no DROP/TRUNCATE and is NOT rerunnable.
-- MySQL DDL commits implicitly; a failure can leave partially created tables.
-- No migration history is inserted here. A future runner must verify the
-- complete schema and checksum before adopting this manual baseline.
SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;
SET SESSION time_zone = '+00:00';

CREATE TABLE users (
  id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nickname     VARCHAR(24) NULL,
  avatar_url   VARCHAR(512) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_openid (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spots (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title          VARCHAR(40) NOT NULL,
  description    VARCHAR(1000) NOT NULL DEFAULT '',
  location       POINT NOT NULL SRID 0,
  lat            DOUBLE NOT NULL,
  lng            DOUBLE NOT NULL,
  province       VARCHAR(64) NULL,
  city           VARCHAR(64) NULL,
  district       VARCHAR(64) NULL,
  address        VARCHAR(256) NULL,
  heading        VARCHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  focal_length   VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  difficulty     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  access_note    VARCHAR(300) NULL,
  cover_photo_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status         VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  view_count     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_spots_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_spots_lat CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT chk_spots_lng CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT chk_spots_heading CHECK (
    heading IS NULL OR heading IN ('N','NE','E','SE','S','SW','W','NW')
  ),
  CONSTRAINT chk_spots_focal CHECK (
    focal_length IS NULL OR focal_length IN ('ultrawide','standard','tele','macro','drone')
  ),
  CONSTRAINT chk_spots_difficulty CHECK (difficulty BETWEEN 1 AND 3),
  CONSTRAINT chk_spots_status CHECK (status IN ('pending','active','hidden','deleted')),
  SPATIAL KEY spx_spots_location (location),
  KEY idx_spots_feed (status, created_at DESC, id DESC),
  KEY idx_spots_city_feed (status, city, created_at DESC, id DESC),
  KEY idx_spots_user_created (user_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_best_times (
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  best_time    VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (spot_id, best_time),
  UNIQUE KEY uk_spot_best_times_order (spot_id, sort_order),
  KEY idx_spot_best_times_value (best_time, spot_id),
  CONSTRAINT fk_spot_best_times_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_best_time CHECK (
    best_time IN ('sunrise','morning','noon','afternoon','sunset','blue_hour','night')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_best_seasons (
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  season       VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (spot_id, season),
  UNIQUE KEY uk_spot_best_seasons_order (spot_id, sort_order),
  KEY idx_spot_best_seasons_value (season, spot_id),
  CONSTRAINT fk_spot_best_seasons_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_season CHECK (season IN ('spring','summer','autumn','winter'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE photos (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key  VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  width       INT UNSIGNED NULL,
  height      INT UNSIGNED NULL,
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_photos_object_key (object_key),
  UNIQUE KEY uk_photos_spot_order (spot_id, sort_order),
  KEY idx_photos_user (user_id),
  CONSTRAINT fk_photos_spot FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT fk_photos_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_photos_size CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT chk_photos_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT chk_photos_height CHECK (height IS NULL OR height > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE spots
  ADD CONSTRAINT fk_spots_cover_photo
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL;

CREATE TABLE upload_tickets (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key  VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  width       INT UNSIGNED NULL,
  height      INT UNSIGNED NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_at     DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_upload_tickets_object_key (object_key),
  KEY idx_upload_tickets_orphan (spot_id, created_at),
  KEY idx_upload_tickets_user_created (user_id, created_at DESC),
  CONSTRAINT fk_upload_tickets_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_upload_tickets_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE SET NULL,
  CONSTRAINT chk_upload_tickets_size CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT chk_upload_tickets_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT chk_upload_tickets_height CHECK (height IS NULL OR height > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE content_check_tasks (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trace_id    VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status      VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  attempts    INT UNSIGNED NOT NULL DEFAULT 0,
  detail      VARCHAR(500) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
              ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_check_tasks_trace (trace_id),
  KEY idx_content_tasks_poll (status, created_at),
  KEY idx_content_tasks_spot (spot_id, status),
  CONSTRAINT fk_content_tasks_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_content_tasks_status CHECK (status IN ('pending','pass','risky','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_reports (
  id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reporter_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason       VARCHAR(64) NOT NULL,
  detail       VARCHAR(200) NULL,
  status       VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_spot_reports_once (spot_id, reporter_id),
  KEY idx_spot_reports_status_created (status, created_at DESC),
  KEY idx_spot_reports_spot_status (spot_id, status),
  KEY idx_spot_reports_reporter (reporter_id),
  CONSTRAINT fk_spot_reports_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT fk_spot_reports_reporter FOREIGN KEY (reporter_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_reports_status CHECK (status IN ('open','resolved','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE schema_migrations (
  name          VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum      CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_ms  INT UNSIGNED NULL,
  applied_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

