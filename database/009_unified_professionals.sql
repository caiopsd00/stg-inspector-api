-- Structure only: support users without login and require a user for each technician.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE technicians ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_credentials_pair
CHECK ((email IS NULL AND password_hash IS NULL) OR
       (email IS NOT NULL AND length(trim(email))>0 AND password_hash IS NOT NULL));
