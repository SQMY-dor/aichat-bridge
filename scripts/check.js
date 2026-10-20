import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateWordList} from '../extension/moderation.js';
let failures=0;
const fail = message => {failures++;console.error(message);};
for(const folder of ['extension','test','scripts','deploy/panel','deploy/panel/public']) for(const name of fs.readdirSync(folder)) {
 if(!name.endsWith('.js'))continue;
 const file=path.join(folder,name);const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
 if(result.status!==0)fail(result.stderr);
}
const manifest=JSON.parse(fs.readFileSync('extension/manifest.json','utf8'));
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(manifest.version!==pkg.version)fail('版本不一致');
if(!fs.readFileSync('extension/content.js','utf8').includes(`const CONTENT_VERSION = '${manifest.version}';`))fail('网页脚本版本标记不一致');
const required=[manifest.background.service_worker,manifest.options_page,...manifest.content_scripts.flatMap(x=>x.js),...manifest.web_accessible_resources.flatMap(x=>x.resources),'offscreen.html','host.js','engine.js','qq-runtime.js', 'feishu-runtime.js', 'platform-router.js', 'assistant-router.js', 'claude-dom.js', 'gemini-dom.js', 'qwen-dom.js', 'work-pump.js','storage.js','qq-store.js', 'feishu-store.js', 'feishu-client.js', 'feishu-message.js', 'feishu-protocol.js', 'answer-post.js', 'cards.js','qq-client.js','qq-message.js','answer-text.js','moderation.js','default-blocked-words.json'];
for(const name of required)if(!fs.existsSync(path.join('extension',name)))fail(`缺少入口文件 ${name}`);
for(const match of fs.readFileSync('extension/options.html','utf8').matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) if(!fs.existsSync(path.join('extension',match[1])))fail(`缺少设置资源 ${match[1]}`);
for(const name of fs.readdirSync('extension').filter(x=>x.endsWith('.js'))) {
 const text=fs.readFileSync(path.join('extension',name),'utf8');
 if(/from\s*['"]node:|\bBuffer\./.test(text))fail(`存在 Node 运行依赖 ${name}`);
 for(const match of text.matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+)['"]/g))if(!fs.existsSync(path.join('extension',match[1])))fail(`缺少导入 ${name} → ${match[1]}`);
}
if(!manifest.permissions.includes('offscreen') || manifest.host_permissions.some(x=>/localhost|127\.0\.0\.1|<all_urls>/.test(x)))fail('纯扩展权限配置异常');
const defaults=JSON.parse(fs.readFileSync('extension/default-blocked-words.json','utf8'));
if(defaults.version!==1||!validateWordList(defaults.words).valid)fail('词表配置无效');
if(failures)process.exitCode=1;else console.log('统一扩展语法、依赖、权限、词表和入口检查通过');
