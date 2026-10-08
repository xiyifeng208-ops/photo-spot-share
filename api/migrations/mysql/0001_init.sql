-- GCJ-02 numbers are stored as X=longitude, Y=latitude, SRID 0.
-- Every connection must use UTC; existing timestamps are imported without truncation.
CREATE TABLE users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  openid VARCHAR(512) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  nickname LONGTEXT, avatar_url LONGTEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE spots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title LONGTEXT NOT NULL, description LONGTEXT NOT NULL DEFAULT (''),
  location POINT NOT NULL SRID 0, lat DOUBLE NOT NULL, lng DOUBLE NOT NULL,
  province LONGTEXT, city VARCHAR(512), district LONGTEXT, address LONGTEXT,
  heading ENUM('N','NE','E','SE','S','SW','W','NW'),
  best_times JSON NOT NULL DEFAULT (JSON_ARRAY()),
  best_seasons JSON NOT NULL DEFAULT (JSON_ARRAY()),
  focal_length ENUM('ultrawide','standard','tele','macro','drone'),
  difficulty SMALLINT NOT NULL DEFAULT 1,
  access_note LONGTEXT,
  cover_photo_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  status ENUM('pending','active','hidden','deleted') NOT NULL DEFAULT 'active',
  view_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT spots_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT spots_difficulty_check CHECK (difficulty BETWEEN 1 AND 3),
  CONSTRAINT spots_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT spots_lng_check CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT spots_times_check CHECK (JSON_SCHEMA_VALID('{"type":"array","items":{"type":"string","enum":["sunrise","morning","noon","afternoon","sunset","blue_hour","night"]}}', best_times)),
  CONSTRAINT spots_seasons_check CHECK (JSON_SCHEMA_VALID('{"type":"array","items":{"type":"string","enum":["spring","summer","autumn","winter"]}}', best_seasons)),
  SPATIAL INDEX spots_location_idx (location),
  INDEX spots_feed_idx (status, created_at DESC, id DESC),
  INDEX spots_city_idx (city, status, created_at DESC, id DESC),
  INDEX spots_user_idx (user_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE photos (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  spot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARCHAR(512) NOT NULL, mime LONGTEXT, size_bytes BIGINT,
  width INT, height INT, sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX photos_spot_idx (spot_id, sort_order, created_at),
  INDEX photos_key_idx (object_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE spots ADD CONSTRAINT spots_cover_photo_fk
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL;

CREATE TABLE upload_tickets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARCHAR(512) NOT NULL UNIQUE, mime LONGTEXT, size_bytes BIGINT,
  width INT, height INT,
  spot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), used_at DATETIME(6),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE SET NULL,
  INDEX upload_tickets_gc_idx (spot_id, created_at),
  INDEX upload_tickets_user_idx (user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_check_tasks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  spot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trace_id VARCHAR(512), status LONGTEXT NOT NULL DEFAULT ('pending'),
  attempts INT NOT NULL DEFAULT 0, detail LONGTEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE CASCADE,
  INDEX content_tasks_trace_idx (trace_id),
  INDEX content_tasks_poll_idx (status(16), created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE spot_reports (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  spot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reporter_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason LONGTEXT NOT NULL, detail LONGTEXT, status LONGTEXT NOT NULL DEFAULT ('open'),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT spot_reports_once UNIQUE (spot_id, reporter_id),
  INDEX spot_reports_status_idx (status(16), created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
