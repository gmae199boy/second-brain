-- 반입 정리의 공유 위치 조회와 미정리 큐 탐색을 빠르게 한다.
create index file_requests_source_locator_idx on brain.file_requests (source, locator);
create index file_import_cleanup_open_idx on brain.file_import_cleanup (request_id) where cleaned_at is null;
