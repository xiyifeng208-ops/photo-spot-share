-- Read-only. Run this file first in Navicat and inspect ALL results.
SELECT VERSION() AS mysql_version, DATABASE() AS selected_database,
       @@session.time_zone AS session_time_zone,
       @@character_set_database AS database_charset,
       @@collation_database AS database_collation;

-- Must show the intended database (currently photo_spot_share) and zero objects.
-- This is an informational check, not an automatic execution guard.
SELECT TABLE_NAME, TABLE_TYPE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

SHOW SESSION STATUS
WHERE Variable_name IN ('Ssl_cipher', 'Ssl_version');

SHOW GRANTS FOR CURRENT_USER;
