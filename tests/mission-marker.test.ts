import test from 'node:test';
import assert from 'node:assert/strict';
import {hasFinalMissionRelayMarker,missionRelayMarker} from '../src/core/mission-marker.js';

test('exact standalone ASCII Mission Relay markers remain unchanged',()=>{
  for(const marker of ['NEXT','DONE','BLOCKED','HANDOFF'] as const){
    const answer=`Evidence reviewed.\n\n[MISSION_RELAY:${marker}]`;
    assert.equal(missionRelayMarker(answer),marker);
    assert.equal(hasFinalMissionRelayMarker(answer),true);
  }
});

test('up to four renderer-inserted zero-width spaces inside only the final marker are accepted',()=>{
  for(const count of [1,2,3,4]){
    const answer=`Complete answer.\n[M${'\u200B'.repeat(count)}ISSION_RELAY:NEXT]`;
    assert.equal(missionRelayMarker(answer),'NEXT');
    assert.equal(hasFinalMissionRelayMarker(answer),true);
  }
});

test('marker parsing does not normalize body text, prefixes, suffixes or other invisible characters',()=>{
  assert.equal(missionRelayMarker('Body\u200B text\n[MISSION_RELAY:NEXT]'),'NEXT',
    'the raw body is preserved and the exact final marker remains independently valid');
  assert.equal(missionRelayMarker('Body\n\u200B[MISSION_RELAY:NEXT]'),null);
  assert.equal(missionRelayMarker('Body\n[MISSION_RELAY:NEXT]\u200B'),null);
  assert.equal(missionRelayMarker(`Body\n[M${'\u200B'.repeat(5)}ISSION_RELAY:NEXT]`),null);
  assert.equal(missionRelayMarker('Body\n[M\u200CISSION_RELAY:NEXT]'),null);
  assert.equal(missionRelayMarker('Body\n[MＩSSION_RELAY:NEXT]'),null);
  assert.equal(missionRelayMarker('Body\n[MISSION_RELAY:NEXT]\nextra text'),null);
  assert.equal(missionRelayMarker('Body [MISSION_RELAY:NEXT]'),null);
});
