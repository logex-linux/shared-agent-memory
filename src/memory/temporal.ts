import type { SQLInputValue } from 'node:sqlite';
import type { MemoryRecord, RecallInput } from '../core/contracts.js';
import { answerIntent, type FactState } from '../retrieval/evidence.js';

export function declaredFactState(value: MemoryRecord['decision_state']): FactState | undefined {
  return value === 'adopted' ? 'implemented' : value;
}

export function decisionIntent(input: RecallInput) {
  return declaredFactState(input.decision_state) ?? answerIntent(input.query ?? '');
}

export function temporalPredicate(input: RecallInput, effectiveAt: string) {
  const clauses:string[]=[];
  const params:SQLInputValue[]=[];
  const lifecycle = "coalesce(json_extract(s.metadata,'$.lifecycle'),'current')";
  if (!input.include_history)
    clauses.push(input.as_of ? `${lifecycle} IN ('current','historical')` : `${lifecycle}='current'`);
  if (input.as_of || !input.include_history) {
    const from = "json_extract(s.metadata,'$.valid_time.valid_from')";
    const to = "json_extract(s.metadata,'$.valid_time.valid_to')";
    clauses.push(`(${from} IS NULL OR julianday(${from})<=julianday(?))`,`(${to} IS NULL OR julianday(${to})>julianday(?))`);
    params.push(effectiveAt,effectiveAt);
  }
  if (input.decision_state) {
    clauses.push("json_extract(s.metadata,'$.decision_state')=?");
    params.push(input.decision_state);
  }
  return {clauses,params};
}

export function coversEffectiveTime(interval:MemoryRecord['valid_time'], at:string) {
  const timestamp=Date.parse(at);
  return (!interval?.valid_from || Date.parse(interval.valid_from)<=timestamp)
      && (!interval?.valid_to || timestamp<Date.parse(interval.valid_to));
}
