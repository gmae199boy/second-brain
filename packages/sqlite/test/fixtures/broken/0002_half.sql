-- Two statements, the second of which the database refuses. The first must not
-- survive the run: a file either took effect whole or not at all.

create table half (a text);

create table half (a text);
