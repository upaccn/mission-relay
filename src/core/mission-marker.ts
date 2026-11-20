/** The browser protocol remains an exact, standalone final-line marker.
 * ChatGPT's rendered transcript has been observed to insert U+200B inside an
 * otherwise literal marker. Accept at most four such characters INSIDE that
 * final line only; never normalize the assistant answer or its SHA-256. */
export type MissionRelayMarker='NEXT'|'DONE'|'BLOCKED'|'HANDOFF';

const FINAL_MARKER=/^\[MISSION_RELAY:(NEXT|DONE|BLOCKED|HANDOFF)\]$/;
const ZERO_WIDTH_SPACE='\u200B';
const MAX_ZERO_WIDTH_MARKER_CHARS=4;

export function missionRelayMarker(answer:string):MissionRelayMarker|null {
  const trimmed=answer.trim();
  if(!trimmed)return null;
  const line=trimmed.slice(trimmed.lastIndexOf('\n')+1);
  // A zero-width prefix/suffix is not part of a standalone marker. Only
  // renderer-inserted characters between its visible ASCII characters pass.
  if(!line||line.startsWith(ZERO_WIDTH_SPACE)||line.endsWith(ZERO_WIDTH_SPACE))
    return null;
  let invisible=0;
  const canonical=line.replace(/\u200B/g,()=>{invisible++;return '';});
  if(invisible>MAX_ZERO_WIDTH_MARKER_CHARS)return null;
  const match=FINAL_MARKER.exec(canonical);
  return (match?.[1] as MissionRelayMarker|undefined)??null;
}

export function hasFinalMissionRelayMarker(answer:string):boolean {
  return missionRelayMarker(answer)!==null;
}
