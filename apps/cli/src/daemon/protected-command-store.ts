import type { ExtensionStore, WorkStore } from 'second_brain';
import type { ProtectedMutation, ProtectedMutationStore } from './protected-mutations.js';
import { protectedMutations, type ProtectedAttemptRevoker } from './protected-mutations.js';

/** 기존 Core 명령이 이 store를 사용한다. 일반 일감은 기존 저장소가 처리한다. */
export function protectedCommandStore<T extends WorkStore & ExtensionStore>(store: T, authority: ProtectedMutationStore, revoker: ProtectedAttemptRevoker): T {
  const manager=protectedMutations(authority,revoker);
  const unavailable={ok:false as const,code:'DB_UNAVAILABLE' as const,message:'보호 서비스 상태를 확인할 수 없습니다'};
  async function protectedScope(action: ProtectedMutation): Promise<boolean | null> {
    try {const rows=await authority.list(action);return rows===null?null:rows.length>0;} catch {return null;}
  }
  return {
    ...store,
    async requestWorkCancel(input) {
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.id))return store.requestWorkCancel(input);
      const action={type:'cancel' as const,id:input.id,at:input.now.toISOString()}, active=await protectedScope(action);
      if(active===null)return unavailable;if(!active)return store.requestWorkCancel(input);
      const result=await manager.executeResult(action);return result?.type==='cancel'?{ok:true as const,state:result.state}:unavailable;
    },
    async holdWorkGroup(input) {
      if(!/^[a-z0-9:_.-]{1,128}$/.test(input.group))return store.holdWorkGroup(input);
      const action={type:'hold' as const,group:input.group,at:input.now.toISOString()}, active=await protectedScope(action);
      if(active===null)return unavailable;if(!active)return store.holdWorkGroup(input);
      const result=await manager.executeResult(action);return result?.type==='hold'?{ok:true as const,held:result.held}:unavailable;
    },
    async setExtensionEnabled(input) {
      if(input.enabled || !/^[a-z][a-z0-9_]{0,30}$/.test(input.name))return store.setExtensionEnabled(input);
      const action={type:'disable' as const,extension:input.name,at:input.now.toISOString()}, active=await protectedScope(action);
      if(active===null)return unavailable;if(!active)return store.setExtensionEnabled(input);
      const result=await manager.executeResult(action);return result?.type==='disable'?{ok:true as const,found:result.found,changed:result.changed}:unavailable;
    },
  };
}
