-- 先发后审：机审通过前，新机位对他人不可见，需要 pending 状态。
-- 单独一个文件：ALTER TYPE ... ADD VALUE 不能与"使用该值"的语句同事务。
ALTER TYPE spot_status ADD VALUE IF NOT EXISTS 'pending' BEFORE 'active';

