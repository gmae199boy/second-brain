# SQLite report input oracle

`src/garmin_pipeline` is the tracked source from Garmin commit
`7fb33dd1661ad25cd73e14ed63abe0a87151f62e`, exported without edits. The
integration fixture invokes this copy in a separate Python process against a
synthetic SQLite database. It invokes the installed PostgreSQL package in a
different process and compares their resulting folders at the same cutoff.
The oracle is test-only; no runtime manifest points to it.
