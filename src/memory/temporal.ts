import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { MemoryRecord, RecallInput } from '../core/contracts.js';
import { answerIntent, type FactState } from '../retrieval/evidence.js';

export function declaredFactState(value: MemoryRecord['decision_state']): FactState | undefined {
  return value === 'adopted' ? 'implemented' : value;
}

export function decisionIntent(input: RecallInput) {
  return declaredFactState(input.decision_state) ?? answerIntent(input.query ?? '');
}

export const TEMPORAL_EXCEPTION = "lifecycle<>'current' OR valid_from_jd IS NOT NULL OR valid_to_jd IS NOT NULL";

export function temporalPredicate(db:DatabaseSync, input: RecallInput, effectiveAt: string) {
  const clauses:string[]=[];
  const params:SQLInputValue[]=[];
  const needsTime=input.as_of || !input.include_history && Boolean(
    db.prepare(`SELECT 1 FROM memory_search WHERE ${TEMPORAL_EXCEPTION} LIMIT 1`).get());
  if (!input.include_history && needsTime)
    clauses.push(input.as_of ? "s.lifecycle IN ('current','historical')" : "s.lifecycle='current'");
  if (needsTime) {
    clauses.push('(s.valid_from_jd IS NULL OR s.valid_from_jd<=julianday(?))',
      '(s.valid_to_jd IS NULL OR s.valid_to_jd>julianday(?))');
    params.push(effectiveAt,effectiveAt);
  }
  if (input.decision_state) {
    clauses.push('s.decision_state=?');
    params.push(input.decision_state);
  }
  return {clauses,params};
}

export function coversEffectiveTime(interval:MemoryRecord['valid_time'], at:string) {
  const timestamp=Date.parse(at);
  return (!interval?.valid_from || Date.parse(interval.valid_from)<=timestamp)
      && (!interval?.valid_to || timestamp<Date.parse(interval.valid_to));
}
