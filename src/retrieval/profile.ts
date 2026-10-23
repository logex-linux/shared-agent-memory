import type {DatabaseSync} from 'node:sqlite';
// Opt-in only. Stage times are exclusive; SQL is charged to the current computation stage.
export class RetrievalProfile {
    times:Record<string,number>={};current='candidates';
    add(name:string,ms:number){this.times[name]=(this.times[name]??0)+ms;}
    stage<T>(name:string,fn:()=>T):T {const old=this.current,start=performance.now();this.current=name;const prior=this.times[name]??0;try{return fn();}finally{this.times[name]=prior+performance.now()-start;this.current=old;}}
    database(db:DatabaseSync):DatabaseSync {
        const p=this;
        return new Proxy(db,{get(target,key){if(key==='prepare')return (sql:string)=>{const st=target.prepare(sql);return new Proxy(st,{get(s,k){const v=Reflect.get(s,k,s);if(typeof v!=='function')return v;return (...args:any[])=>{const start=performance.now();try{return v.apply(s,args);}finally{if(p.current==='candidates')p.add(sql.includes('embedding MATCH')?'knn':/chunk_fts MATCH|WITH matches AS/.test(sql)?'fts_identifiers':'candidate_sql',performance.now()-start);}};}});};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}}) as DatabaseSync;
    }
}
