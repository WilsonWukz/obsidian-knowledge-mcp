import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveServerGroups} from '../src/sync/semantics.ts';
const M='INSES/M00-关系总览.md',A='INSES/P21-Dense-X-Retrieval.md',B='INSES/P18-RAG.md';
const base={
 [M]:'- [[P21#^R-P21-01]]：旧关系\n- [[P18#^R-P18-01]]：另一条关系',
 [A]:'### R-P21-01\n旧证据',
 [B]:'### R-P18-01\n另一证据',
};
const group=(files,id)=>deriveServerGroups(base,files).find(g=>g.id==='relation:'+id);
test('server ties one edited M00 relation to unchanged evidence note',()=>{
 assert.deepEqual(group({...base,[M]:base[M].replace('旧关系','更正含义')},'R-P21-01').paths,[M,A].sort());
});
test('unmarked edit in one-relation note remains related',()=>{
 assert.deepEqual(group({...base,[A]:'### R-P21-01\n更正证据'},'R-P21-01').paths,[M,A].sort());
});
test('unmarked edit in multi-relation overview fails closed',()=>{
 assert.throws(()=>deriveServerGroups(base,{...base,[M]:base[M]+'\n未说明属于哪条关系'}),{code:'SEMANTIC_SCOPE_REQUIRED'});
});
test('server derives both relation groups for separate changes',()=>{
 const out=deriveServerGroups(base,{...base,[M]:base[M].replace('旧关系','新关系'),[B]:'### R-P18-01\n新证据'});
 assert.ok(out.some(g=>g.id==='relation:R-P21-01'&&g.paths.includes(A)));
 assert.ok(out.some(g=>g.id==='relation:R-P18-01'));
});
test('single ordinary note is grouped by file',()=>{
 const out=deriveServerGroups({'INSES/A.md':'a'},{'INSES/A.md':'b'});
 assert.deepEqual(out,[{id:'file:INSES/A.md',paths:['INSES/A.md']}]);
});
test('removed markers preserve old dependency membership',()=>{
 const out=group({...base,[M]:base[M].replace('R-P21-01','no-id')},'R-P21-01');
 assert.ok(out.paths.includes(M)&&out.paths.includes(A));
});
test('unrelated two-file batch gets one shared group',()=>{
 const out=deriveServerGroups({'INSES/A.md':'old','INSES/B.md':'old'},{'INSES/A.md':'new','INSES/B.md':'new'});
 assert.ok(out.some(g=>g.id.startsWith('batch:')&&g.paths.length===2));
});
test('multi-relation note deletion is blocked',()=>{
 const {[M]:_,...rest}=base;
 assert.throws(()=>deriveServerGroups(base,rest),{code:'SEMANTIC_SCOPE_REQUIRED'});
});
