/** A zero stored limit means no Mission-level turn ceiling. Only explicitly
 * bounded legacy/native Missions have a finite limit. The separate per-Chat Send
 * ChatGPT conversation ceiling remains mandatory for every PI Mission. */
export const UNBOUNDED_MISSION_TURNS=0;

export const missionTurnsRemaining=(maxTurns:number,turnCount:number):boolean=>
  maxTurns===UNBOUNDED_MISSION_TURNS||turnCount<maxTurns;

export const missionTurnLimitReached=(maxTurns:number,turnCount:number):boolean=>
  maxTurns!==UNBOUNDED_MISSION_TURNS&&turnCount>=maxTurns;

export const formatMissionTurns=(turnCount:number,maxTurns:number):string=>
  maxTurns===UNBOUNDED_MISSION_TURNS?String(turnCount):`${turnCount}/${maxTurns}`;
