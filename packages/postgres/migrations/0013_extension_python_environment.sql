CREATE TABLE brain.extension_python_environment (
  name text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  code text,
  checked_at timestamptz NOT NULL
);
