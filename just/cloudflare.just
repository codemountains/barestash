[group('dev')]
[working-directory('apps/api')]
[doc('Run a local D1 SQL query against the persisted dev state')]
d1-query sql:
    pnpm exec wrangler d1 execute barestash \
      --local \
      --persist-to .wrangler/state \
      --command {{quote(sql)}}

[group('dev')]
[working-directory('apps/api')]
[doc('Fetch a local R2 object by key (without the bucket name prefix)')]
r2-get key:
    pnpm exec wrangler r2 object get \
      barestash-request-bodies/{{key}} \
      --local \
      --persist-to .wrangler/state \
      --pipe
