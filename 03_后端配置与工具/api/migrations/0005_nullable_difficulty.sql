-- Unknown is not “easy”: preserve existing values and stop defaulting new rows to 1.
ALTER TABLE spots ALTER COLUMN difficulty DROP NOT NULL;
ALTER TABLE spots ALTER COLUMN difficulty DROP DEFAULT;
