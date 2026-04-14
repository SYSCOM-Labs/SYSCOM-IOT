UPDATE users SET role = 'user' WHERE role = 'viewer';
UPDATE users SET role = 'superadmin'
WHERE role = 'admin' AND (created_by IS NULL OR trim(created_by) = '');
