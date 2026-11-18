// Static API adapter with fictional content; never logs in to or modifies production.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),express=require('express');
const {chromium}=require('playwright');
const output=path.resolve('.local/learning-display');
const method='以我方为仓储转租承租方，逐项核对原转租权限保证、同意书提供时间、同意覆盖的场所和用途、交付节点、起租及付款条款。区分合同中的提供承诺与实际证明材料；核验材料时结合主租约相关部分及书面同意，不能以保证条款代替文件核验。'+ '交付前后分别记录补充资料、付款与保留权利的约定；对材料缺口和未明确条件逐项列为待确认，不推测已经补齐。'.repeat(7);
const base={kind:'skill',scope:'type',reason:'虚构样例：确认稿补充转租同意书与起租付款的联动安排，提炼为待人工核对的方法。',method,conditions:['我方为仓储转租承租方，使用权依赖主租约及必要的转租同意。','转租同意书、交付与起租或付款条件存在关联。','逐案核实救济条件，不直接套用个案结果。'],exclusions:['不能仅据最终同意推定已取得有效转租许可。','不得将个案暂缓付款安排推广为所有交易的强制标准。'],examples:['对方应于【待确认期限】前提供载明用途与区域的书面同意；未按约提供时，双方另行明确【待确认救济条件】。'],instruction:'',evidence:[{versionId:'fixture-current-version',blockId:'b12',quote:'交付前提供书面转租同意，核实付款及起租安排。'}],findingIds:[],dependsOn:[]};
const task={id:'fixture-task',contract_id:'fixture-contract',contractTitle:'【虚构展示样例】仓储转租合同.docx',confirmedVersionNo:4,confirmedBy:'虚构确认人',contractTypeName:'租赁合同',created_at:'2026-11-05T02:00:00Z',status:'awaiting_confirmation',revision:1,
 snapshot:{typeId:'lease',rulePacks:[],skillPacks:[{skills:[{id:'existing-method',method:'原有方法：核对起租日期与付款日。'}]}]},
 sourceContext:{decision:{outcome:'agree',reason:'虚构验收结论',conditions:''},previousVersion:{id:'fixture-old-version',versionNo:3,filename:'虚构上一版.docx'},currentVersion:{id:'fixture-current-version',versionNo:4,filename:'虚构确认稿.docx'},comparison:'previous_version',comparisonSummary:{changed:18},findings:[],warnings:[]},
 proposals:[{...base,id:'new-method',title:'仓储转租同意书与起租、付款安排的联动核对',state:'adopted',draftVersionId:'fixture-draft',draftState:'pending'},
 {...base,id:'existing-update',title:'补充既有起租日期核对方法',state:'pending',targetId:'existing-method',method:'补充方法：结合交付、起租和付款约定交叉检查。'},
 {...base,id:'empty-sections',title:'仅有方法的新增经验',state:'pending',method:'核对缺少条件的事项，明确请人工补充。',conditions:[],exclusions:[],examples:[],evidence:[]}]};
(async()=>{let server,browser;const result={fictionalFixture:true,productionRequests:0,errors:[]};try{
 const app=express();app.get('/api/auth/session',(_,res)=>res.json({user:{displayName:'虚构验收账号',roles:['admin']},csrf:'fixture'}));
 app.get('/api/learning-tasks',(_,res)=>res.json([task]));app.get('/api/learning-settings',(_,res)=>res.json({enabled:true}));
 app.get('/api/catalog',(_,res)=>res.json({categories:[],tags:[]}));app.get('/api/:resource',(_,res)=>res.json([]));
 app.use('/api',(_,res)=>res.status(405).json({message:'只读展示样例'}));app.use(express.static(path.resolve(process.env.LEARNING_UI_DIST || 'frontend/dist')));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1600,height:1100}});page.on('pageerror',e=>result.errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/#/feedback`);const cards=page.locator('.learning-proposal');await cards.first().waitFor();
 assert.equal(await cards.count(),3);assert.equal(await cards.first().getAttribute('open'),null);assert.equal(await cards.nth(1).getAttribute('open'),null);await cards.first().locator('summary').first().click();assert.equal(await cards.first().getAttribute('open'),'');result.defaultCollapsed=true;
 await cards.first().getByText('已提交审核',{exact:true}).waitFor();await page.getByText('确认人：虚构确认人',{exact:true}).waitFor();
 assert.equal(await page.locator('.learning-task-heading').innerText().then(t=>t.includes('fixture-current-version')),false);
 assert.equal(await cards.first().getByText('原内容',{exact:true}).count(),0);assert.equal(await cards.first().locator('.proposal-previous').count(),0);
 await cards.first().getByRole('button',{name:'展开完整方法',exact:true}).click();assert.equal(await cards.first().locator('.proposal-method p').textContent(),method);
 await cards.first().getByRole('button',{name:'收起方法',exact:true}).click();await page.screenshot({path:path.join(output,'经验展示-桌面.png'),fullPage:true});result.longMethodPreserved=true;result.noEmptyOriginalColumn=true;result.actualDraftState=true;
 const examples=cards.first().locator('.proposal-examples');await examples.locator('summary').click();await examples.getByText(base.examples[0],{exact:true}).waitFor();
 await cards.first().locator('.proposal-basis>summary').click();await cards.first().getByText(base.evidence[0].quote,{exact:true}).waitFor();result.examplesAndEvidence=true;
 await cards.nth(1).locator('summary').first().focus();await page.keyboard.press('Enter');assert.equal(await cards.nth(1).getAttribute('open'),'');
 await cards.nth(1).locator('.proposal-previous>summary').click();await cards.nth(1).getByText('原有方法：核对起租日期与付款日。',{exact:true}).waitFor();result.keyboardAndPreviousContent=true;
 await cards.nth(2).locator('summary').first().click();assert.equal(await cards.nth(2).locator('.proposal-conditions,.proposal-examples').count(),0);
 for(const width of [980,390]){await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.screenshot({path:path.join(output,'经验展示-手机.png'),fullPage:true});result.narrowLayout=true;assert.deepEqual(result.errors,[]);result.passed=true;
}finally{fs.writeFileSync(path.join(output,'display-browser-result.json'),JSON.stringify(result,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}console.log(JSON.stringify(result));})().catch(e=>{console.error(e.stack);process.exitCode=1});
