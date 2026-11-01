-- 폐기 증거는 보호 supervisor의 복구 조회 전용이며 사용자 역할에 노출하지 않는다.
grant select on brain.protected_auth_revocations to brain_protected_supervisor;
