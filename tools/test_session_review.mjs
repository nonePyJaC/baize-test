import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'baize-review-'));
try {
 const file=join(temp,'fixture.mjs');
 await build({stdin:{contents:`export * from './src/lib/reviewProposal'; export * from './src/lib/cases'; export {api} from './src/lib/api';`,resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent',banner:{js:`import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);`}});
 const m=await import(pathToFileURL(file));
 const warn=console.warn;console.warn=()=>{};
 const dir='/fixture/session-review';
 const cases=Array.from({length:30},(_,i)=>({...m.newCase('module'),id:`stable-${i}`,title:`tc-p1-功能测试: 场景${i}`}));
 const doc=m.normalizeCasesDocument({tree:{id:'root',title:'fixture',children:[{id:'module',title:'门店端',children:[]}]},cases},'FIXTURE','mock','mock');
 await m.api.createJsonFile(`${dir}/04-测试用例/cases.json`,doc);
 const items=cases.slice(0,18).map((c,i)=>({item_id:`delete-${i}`,target_case_id:c.id,action:'deleted',before:c,after:null,reason:i===0?'APP消息由其他同学负责':'批次待重写',nature:'user_request',source_refs:['fixture/review.md'],status:'accepted',handling_reason:'用户确认本次范围'}));
 for(let i=0;i<12;i++){const c={...cases[0],id:`new-${i}`};items.push({item_id:`add-${i}`,target_case_id:c.id,action:'added',before:null,after:c,reason:'新增正确批次场景',nature:'ai_suggestion',source_refs:['fixture/review.md'],status:'accepted',handling_reason:'已核对需求'});}
 const rejected={item_id:'rejected',target_case_id:cases[20].id,action:'modified',before:cases[20],after:{...cases[20],title:'不应应用'},reason:'开发建议',nature:'developer_suggestion',source_refs:['fixture/review.md'],status:'rejected',handling_reason:'保留人工不默认规则'};
 items.push(rejected);
 const proposal=m.validateReviewProposal({proposal_id:'review-fixture',requirement_id:'FIXTURE',platform_id:'mock',items},'mock','FIXTURE');
 const preview=await m.previewReview(dir,proposal);assert.equal(preview.preview.length,30);
 const applied=await m.applyReview(dir,proposal);
 const actual=await m.api.readJsonFile(`${dir}/04-测试用例/cases.json`);
 assert.equal(actual.cases.length,24);assert.equal(actual.cases.find(c=>c.id===cases[20].id).title,cases[20].title);
 assert.equal(m.reviewHasUnresolved(applied),false);
 await m.applyReview(dir,applied);
 const events=await m.api.readJsonFile(`${dir}/04-测试用例/case-events.json`);assert.equal(events.events.length,30);
 const conflict={...proposal,proposal_id:'conflict',items:[{...rejected,status:'accepted',handling_reason:'沿用旧建议',before:{...cases[20],title:'旧大承包默认'}}]};
 await assert.rejects(m.applyReview(dir,conflict),/冲突/);
 assert.throws(()=>m.validateReviewProposal(proposal,'other-platform','FIXTURE'),/平台/);
 console.warn=warn;console.log('PASS: 12新增/18删除、部分拒绝、人工冲突、稳定ID、重复应用不新增事件（内存fixture）');
} finally {await rm(temp,{recursive:true,force:true});}
