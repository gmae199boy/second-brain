// Dependency-free ABI v1 fixture: validate every required environment value.
const env = process.env;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const valid = env.BRAIN_ABI_VERSION === '1' && /^postgres(?:ql)?:\/\//.test(env.BRAIN_DATABASE_URL ?? '') &&
  uuid.test(env.BRAIN_WORK_ID ?? '') && uuid.test(env.BRAIN_ATTEMPT_TOKEN ?? '') &&
  env.BRAIN_WORK_KIND === 'testext.connection_check' && env.BRAIN_TARGET_KIND === 'extension' && env.BRAIN_TARGET_ID === 'testext' && env.BRAIN_RUN_GENERATION === '1';
if (!valid) {
  console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false, message: '환경 변수가 올바르지 않습니다' }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ abi: 1, type: 'progress', message: '연결을 확인합니다' }));
  console.log(JSON.stringify({ abi: 1, type: 'result', summary: 'connected' }));
}
