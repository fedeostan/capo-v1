-- Security-advisor cleanup: pin lisbon_today()'s search_path. The body only
-- touches pg_catalog builtins, so an empty search_path changes nothing
-- functionally — it just closes the mutable-search-path lint from 0011.
alter function lisbon_today() set search_path = '';
