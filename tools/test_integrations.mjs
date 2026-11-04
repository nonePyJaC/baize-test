import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'baize-integrations-'));
try {
 const file=join(temp,'fixture.mjs');
 await build({stdin:{contents:`export * from './src/services/integrations'; export * from './src/lib/selectSearch'; export * from './src/lib/report'; export {DEFAULT_CLIENT_PREFERENCES,api} from './src/lib/api'; export {createTestCaseResult} from './src/lib/testExecution'; export {readPlan,withPlan} from './src/components/ExternalPlanPicker';`,resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',external:['@tauri-apps/*'],define:{'import.meta.env.DEV':'false'}});
 const m=await import(pathToFileURL(file));
 const peopleSearch=m.selectSearchIndex(['张三','person-zhang','zhangsan@fixture.invalid']);
 for(const q of ['张','张三','zhangsan','ZHANG SAN','zs','person-zhang','fixture.invalid'])assert.ok(m.matchesSelectSearch(peopleSearch,q),q);
 assert.equal(m.matchesSelectSearch(peopleSearch,'李四'),false);
 assert.ok(m.matchesSelectSearch(m.selectSearchIndex(['肖扬']),'xiaoyang'));
 const form={parent_required:true,assignee_required:true,fields:[
  {id:'priority',default_value:'middle',options:[{id:'middle',label:'中'},{id:'high',label:'高'}]},
  {id:'severity',default_value:'general',options:[{id:'general',label:'3-一般'}]},
  {id:'invalid',default_value:'removed',options:[{id:'available',label:'可用'}]},
 ]};
 assert.deepEqual(m.defectFieldDefaults(form),{priority:'middle',severity:'general'});
 assert.deepEqual(m.defectFieldDefaults({...form,fields:[{...form.fields[0],default_value:'high'}]}),{priority:'high'});
 const a={connection_id:'org-a',provider_id:'yunxiao',entity_type:'defect',external_id:'same-id',display_key:'BUG-1',title:'自动创建缺陷',linked_at:'2026-10-22'};
 const b={...a,connection_id:'org-b',title:'另一组织缺陷'};
 assert.equal(m.mergeReferences([a],[a,b]).length,2);
 const result={...m.createTestCaseResult('local-id'),status:'failed',external_refs:[a,b],defect_url:'https://manual.invalid/42'};
 const data=m.buildReportData({requirement_yaml:{requirement:{id:'LOCAL',name:'本地需求'}},platform_name:'fixture',run:{run_id:'run-fixture',execution_scope:{case_ids:['local-id']},environment:'local',application_versions:'v1'},snapshot:{cases:[{id:'local-id',title:'本地用例'}]},results:{results:[result]},risks:'',remaining_issues:''});
 assert.match(data.failed_cases[0].defect_url,/BUG-1/);assert.match(data.failed_cases[0].defect_url,/自动创建缺陷/);assert.match(data.failed_cases[0].defect_url,/manual.invalid/);
 assert.match(m.defectSummary({yunxiao_bug_id:'old',yunxiao_bug_serial:'OLD-9',yunxiao_bug_subject:'旧缺陷'}),/OLD-9.*旧缺陷/);
 assert.equal(m.defectReferences({yunxiao_bug_id:'old'})[0].connection_id,'legacy-unresolved');
 const prefs={...m.DEFAULT_CLIENT_PREFERENCES,yunxiao:{...m.DEFAULT_CLIENT_PREFERENCES.yunxiao,enabled:true,access_token:'fixture',organization_id:'old-org'}};
 assert.equal(m.connectionsFromPreferences(prefs).length,1);
 assert.deepEqual(m.connectionsFromPreferences({...prefs,connections:[]}),[]);
 const connections=[{connection_id:'one',enabled:true,capabilities:['defects']},{connection_id:'two',enabled:true,capabilities:['defects']}];
 assert.equal(m.selectConnection(connections,'defects','defect'),undefined);
 assert.equal(m.selectConnection(connections,'defects','defect',{defect:'two'},{defect:'one'}).connection_id,'two');
 assert.equal(m.selectConnection(connections,'defects','defect',{defect:'missing'},{defect:'one'}),undefined);
 const yc={connection_id:'yunxiao-original',provider_id:'yunxiao',enabled:true,capabilities:['defects','requirements'],config:{}};
 const mc={...yc,connection_id:'other-system',provider_id:'memory'};
 const legacyRequirement={yunxiao:{project_id:'project-original',workitem_id:'story-original',workitem_serial:'DEMO-1002',workitem_subject:'原绑定需求'}};
 const originalRequirement=JSON.stringify(legacyRequirement);
 assert.equal(m.selectDefectConnection([yc,mc],legacyRequirement).connection_id,yc.connection_id);
 assert.equal(m.selectDefectConnection([yc,{...yc,connection_id:'yunxiao-other'}],legacyRequirement),undefined);
 assert.equal(m.selectDefectConnection([yc,mc],legacyRequirement,{defect:mc.connection_id}).connection_id,mc.connection_id);
 const integrationCall=m.api.integrationCall;
 let reads=0;
 m.api.integrationCall=async(c,op,args)=>{reads++;assert.equal(c.connection_id,yc.connection_id);assert.equal(op,'requirement');assert.equal(args.external_id,'story-original');return {connection_id:c.connection_id,provider_id:c.provider_id,entity_type:'requirement',external_id:'story-original',display_key:'DEMO-1002',title:'原绑定需求',project_ref:'project-original',linked_at:''};};
 const legacyContext=await m.resolveDefectContext(legacyRequirement,yc);
 assert.equal(legacyContext.project_ref,'project-original');assert.equal(legacyContext.parent.external_id,'story-original');
 assert.equal(legacyContext.parent.connection_id,yc.connection_id);assert.equal(reads,1);
 assert.equal(JSON.stringify(legacyRequirement),originalRequirement);
 assert.equal(m.requirementReferences(legacyRequirement)[0].connection_id,'legacy-unresolved');
 assert.deepEqual(await m.resolveDefectContext(legacyRequirement,mc),{project_ref:''});assert.equal(reads,1);
 const boundRequirement={...legacyRequirement,external_refs:[legacyContext.parent]};
 assert.equal(m.selectDefectConnection([yc,mc],boundRequirement).connection_id,yc.connection_id);
 assert.equal((await m.resolveDefectContext(boundRequirement,yc)).parent.external_id,'story-original');assert.equal(reads,1);
 assert.deepEqual(await m.resolveDefectContext(boundRequirement,{...yc,connection_id:'different-org'}),{project_ref:''});assert.equal(reads,1);
 m.api.integrationCall=async()=>({...legacyContext.parent,project_ref:'wrong-project'});
 await assert.rejects(()=>m.resolveDefectContext(legacyRequirement,yc),/原绑定不一致/);
 m.api.integrationCall=async()=>{throw Error('原组织不可访问');};
 await assert.rejects(()=>m.resolveDefectContext(legacyRequirement,yc),/原组织不可访问/);
 m.api.integrationCall=integrationCall;
 const core=JSON.parse(await readFile('src-tauri/capabilities/core.json','utf8'));
 // Tauri onCloseRequested finishes by calling Window.destroy(), including when there are no drafts.
 assert.ok(core.permissions.includes('core:window:allow-close'));assert.ok(core.permissions.includes('core:window:allow-destroy'));
 assert.equal(m.readPlan(m.withPlan({yunxiao_test_plan:{id:'old-plan',name:'Old'}},null)),null);
 assert.equal(m.readPlan({yunxiao_test_plan:{id:'old-plan',name:'Old'}}).connection_id,'legacy-unresolved');
 console.log('PASS: 缺陷默认值/无效选项、中文/全拼/首字母/别名搜索、外部引用去重/跨组织隔离、自动缺陷进入报告、手填及旧字段兼容、多连接选择、旧需求自动绑定/原ID只读核验/不串组织、原生窗口关闭权限、计划取消关联（内存fixture）');
}finally{await rm(temp,{recursive:true,force:true});}
