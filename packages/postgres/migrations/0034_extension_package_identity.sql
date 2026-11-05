-- Legacy bundled installs have no package identity. Keep them distinguishable
-- from verified marketplace packages and leave their existing state intact.
alter table brain.extensions add column package_digest text;
alter table brain.extensions add column plugin_version text;
alter table brain.extensions add constraint extension_package_identity_check check (
  (package_digest is null and plugin_version is null) or
  (package_digest is not null and plugin_version is not null and package_digest ~ '^[0-9a-f]{64}$' and plugin_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
);
