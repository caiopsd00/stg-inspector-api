-- Index existing creation audit entries; no business data is changed.
CREATE INDEX audit_catalog_creation_access_idx
ON audit (user_id, entity_type, id DESC) INCLUDE (entity_id)
WHERE action = 'save' AND before_data IS NULL;
