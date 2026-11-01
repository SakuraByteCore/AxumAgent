import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';
import {
	SUBAGENT_EXECUTION_CONTRACT,
	SUBAGENT_NUDGE_MAX_ATTEMPTS,
	requiresToolEvidence,
	subagentForcedWrapup,
	subagentIdleReminder,
} from '../plugin/pi-agent/subagent-contract.ts';
import {ensureChildToolEvidence} from '../plugin/pi-agent/child-recovery.ts';
import {NO_TEXT_RESPONSE_NUDGE,recoverEmptyText} from '../plugin/pi-agent/final-response.ts';

function fakeSession(options={}){
	const prompts=[];
	const messages=[];
	return {
		prompts,
		messages,
		agent:{state:{messages}},
		getActiveToolNames:()=>options.tools??['read'],
		prompt:async text=>{
			prompts.push(text);
			messages.push({role:'assistant',content:[{type:'text',text:options.text??'done'}],stopReason:'stop'});
			if(options.onPrompt)await options.onPrompt(prompts.length,prompts.length-1);
		},
		waitForIdle:async()=>{},
	};
}

test('subagent contract states the execution discipline and marks tool-evidence roles',()=>{
	assert.match(SUBAGENT_EXECUTION_CONTRACT,/MUST continue with another tool call/);
	assert.match(SUBAGENT_EXECUTION_CONTRACT,/NEVER end on a plan/);
	assert.match(SUBAGENT_EXECUTION_CONTRACT,/No TODO tracking/);
	assert.deepEqual(
		['explorer','librarian','designer','fixer','oracle'].filter(requiresToolEvidence),
		['explorer','librarian','designer','fixer'],
	);
	assert.equal(requiresToolEvidence(undefined),false);
	assert.match(subagentIdleReminder(1,2),/Reminder 1 of 2/);
	assert.match(subagentForcedWrapup(),/Final wrap-up/);
});

test('zero tool evidence triggers bounded reminders and one forced wrap-up',async()=>{
	const session=fakeSession();
	const agent={toolUses:0};
	await ensureChildToolEvidence(session,agent,'explorer');
	assert.equal(session.prompts.length,SUBAGENT_NUDGE_MAX_ATTEMPTS+1);
	assert.match(session.prompts[0],/Reminder 1 of 2/);
	assert.match(session.prompts.at(-1),/Final wrap-up/);
});

test('tool evidence stops the reminder loop',async()=>{
	const agent={toolUses:0};
	const session=fakeSession({onPrompt:async count=>{if(count===1)agent.toolUses=1;}});
	await ensureChildToolEvidence(session,agent,'explorer');
	assert.equal(session.prompts.length,1,'reminder stops once the child used a tool');
	assert.equal(agent.toolUses,1);
});

test('tool evidence present from the start skips reminders entirely',async()=>{
	const session=fakeSession();
	await ensureChildToolEvidence(session,{toolUses:3},'fixer');
	assert.equal(session.prompts.length,0);
});

test('text-only child sessions and pure reasoning roles skip reminders',async()=>{
	const session=fakeSession({tools:[]});
	await ensureChildToolEvidence(session,{toolUses:0},'explorer');
	assert.equal(session.prompts.length,0);
	const oracleSession=fakeSession();
	await ensureChildToolEvidence(oracleSession,{toolUses:0},'oracle');
	assert.equal(oracleSession.prompts.length,0);
});

test('empty text turn gets exactly one plain-text recovery prompt',async()=>{
	const session=fakeSession();
	await recoverEmptyText(session);
	assert.deepEqual(session.prompts,[NO_TEXT_RESPONSE_NUDGE]);
});

test('compiled runner injects the contract and nudges a silent child',async()=>{
	const root=mkdtempSync(join(process.cwd(),'test/e2e-subagent-contract-'));
	try{
		cpSync('plugin/pi-agent',join(root,'pi-agent'),{recursive:true});
		compileExtensionPackage({packageRoot:join(root,'pi-agent')});
		const {runChildTurns}=await import(pathToFileURL(join(root,'pi-agent/runner.js')).href);
		const {formatChildResultBody,CHILD_RESULT_INLINE_LIMIT,CHILD_RESULT_PREVIEW_LIMIT}=await import(pathToFileURL(join(root,'pi-agent/transcript.js')).href);
		const prompts=[],messages=[],posts=[];
		const session={
			agent:{state:{messages}},
			getActiveToolNames:()=>['read'],
			prompt:async text=>{prompts.push(text);messages.push({role:'assistant',content:[{type:'text',text:'final report'}],stopReason:'stop'});},
			waitForIdle:async()=>{},
		};
		const agent={id:'a',sessionId:'s',command:'agent',task:'inspect callers',model:'m',modelLabel:'m',notifyMainAgent:true,status:'running',executionTimeoutMs:1000,responseText:'',toolUses:0,turnCount:0,turnStartedAt:Date.now(),startedAt:Date.now(),activeTools:new Map(),conversationMessages:[],finished:new Promise(()=>{}),oneShot:true};
		await runChildTurns({sendMessage:m=>posts.push(m),appendEntry:()=>{}},()=>false,'inspect callers',session,agent,{update(){},addCompleted(){}}, 'explorer');
		assert.match(prompts[0],/\[Execution contract\]/);
		assert.match(prompts[0],/inspect callers/);
		assert.equal(prompts.length,SUBAGENT_NUDGE_MAX_ATTEMPTS+2,'one task prompt plus reminders and the forced wrap-up');
		assert.match(prompts.at(-1),/Final wrap-up/);
		assert.equal(posts.length,1);
		assert.match(String(posts[0].content),/final report/);
		const short='small result';
		assert.equal(formatChildResultBody(short,'a'),short);
		const long='x'.repeat(CHILD_RESULT_INLINE_LIMIT+100);
		const preview=formatChildResultBody(long,'agent-7');
		assert.ok(preview.length<long.length);
		assert.match(preview,/Result truncated for the parent context budget/);
		assert.match(preview,/agentId="agent-7"/);
		assert.ok(preview.startsWith('x'.repeat(CHILD_RESULT_PREVIEW_LIMIT)));
	}finally{rmSync(root,{recursive:true,force:true});}
});
