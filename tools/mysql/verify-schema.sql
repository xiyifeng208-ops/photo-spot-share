-- Read-only checks after 0001_mysql_baseline.sql succeeds.
SELECT VERSION() AS mysql_version, DATABASE() AS selected_database;

-- Expected: nine tables, all InnoDB and utf8mb4_0900_ai_ci.
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;

-- Expected: PRIMARY KEY=9, FOREIGN KEY=11, UNIQUE=8, CHECK=16.
SELECT CONSTRAINT_TYPE, COUNT(*) AS constraint_count
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
GROUP BY CONSTRAINT_TYPE
ORDER BY CONSTRAINT_TYPE;

-- All 16 CHECK constraints must be enforced (YES).
SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK'
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

SELECT TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, DELETE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

-- location must be point, NOT NULL, SRID=0; spatial index must exist.
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, SRS_ID
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spots' AND COLUMN_NAME = 'location';

SELECT TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE,
       SEQ_IN_INDEX, COLUMN_NAME, COLLATION
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Exact row counts, unlike information_schema estimates. Expected: all zero.
SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'spots', COUNT(*) FROM spots
UNION ALL SELECT 'spot_best_times', COUNT(*) FROM spot_best_times
UNION ALL SELECT 'spot_best_seasons', COUNT(*) FROM spot_best_seasons
UNION ALL SELECT 'photos', COUNT(*) FROM photos
UNION ALL SELECT 'upload_tickets', COUNT(*) FROM upload_tickets
UNION ALL SELECT 'content_check_tasks', COUNT(*) FROM content_check_tasks
UNION ALL SELECT 'spot_reports', COUNT(*) FROM spot_reports
UNION ALL SELECT 'schema_migrations', COUNT(*) FROM schema_migrations;

-- Standalone spatial function check; no data is inserted.
SELECT ST_X(ST_GeomFromText('POINT(121.4903 31.2397)', 0)) AS longitude,
       ST_Y(ST_GeomFromText('POINT(121.4903 31.2397)', 0)) AS latitude,
       ST_SRID(ST_GeomFromText('POINT(121.4903 31.2397)', 0)) AS srid;
