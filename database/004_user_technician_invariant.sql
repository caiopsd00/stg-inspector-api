-- Newly created or changed login accounts must have a linked technical profile.
-- Existing accounts are not rewritten: provision/link them with create:user and a CPF.
CREATE FUNCTION require_technician_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    target_user_id := NEW.id;
  ELSIF TG_OP <> 'INSERT' THEN
    target_user_id := OLD.user_id;
  END IF;

  IF target_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM users WHERE id=target_user_id)
     AND NOT EXISTS (SELECT 1 FROM technicians WHERE user_id=target_user_id) THEN
    RAISE EXCEPTION 'Usuário % precisa ter um cadastro de técnico vinculado.', target_user_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER users_require_technician
AFTER INSERT OR UPDATE ON users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_technician_for_user();

CREATE CONSTRAINT TRIGGER technicians_keep_user_link
AFTER UPDATE OR DELETE ON technicians
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_technician_for_user();
