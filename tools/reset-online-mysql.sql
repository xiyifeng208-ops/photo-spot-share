-- DESTRUCTIVE: only run in photo_spot_share after verifying the online backup.
-- Does not touch the local PostgreSQL database. No application writes during cutover.
USE photo_spot_share;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS content_check_tasks;
DROP TABLE IF EXISTS spot_reports;
DROP TABLE IF EXISTS spot_best_times;
DROP TABLE IF EXISTS spot_best_seasons;
DROP TABLE IF EXISTS upload_tickets;
DROP TABLE IF EXISTS photos;
DROP TABLE IF EXISTS spots;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS schema_migrations;
SET FOREIGN_KEY_CHECKS = 1;
