import type {DatabaseSync,StatementSync} from 'node:sqlite';
const connections=new WeakMap<DatabaseSync,DatabaseSync>();
// Per-connection bounded statement cache. Bindings contain IDs/query parameters, never retained result bodies.
// Native db.prepare remains observable on cache misses (tests can instrument returned statements).
export function prepared(db:DatabaseSync):DatabaseSync {
    let wrapped=connections.get(db);if(wrapped)return wrapped;
    const statements=new Map<string,StatementSync>();
    wrapped=new Proxy(db,{get(target,key){if(key==='prepare')return (sql:string)=>{let s=statements.get(sql);if(s){statements.delete(sql);statements.set(sql,s);return s;}s=target.prepare(sql);statements.set(sql,s);if(statements.size>96)statements.delete(statements.keys().next().value!);return s;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}) as DatabaseSync;
    connections.set(db,wrapped);return wrapped;
}
