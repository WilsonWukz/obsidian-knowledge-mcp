import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const dir=resolve(import.meta.dirname,'..');
const [core,plugin,manifest]=await Promise.all([
  readFile(join(dir,'src/core.js'),'utf8'),
  readFile(join(dir,'src/plugin.js'),'utf8'),
  readFile(join(dir,'manifest.json'),'utf8')
]);
const m=JSON.parse(manifest);
if(m.id!=='guarded-sync'||m.isDesktopOnly!==true)throw Error('Invalid release manifest');
if(!plugin.includes("require('./core.js')"))throw Error('Missing injected pure protocol');
const built=`/* Guarded Sync ${m.version}: bundled, desktop-only; source in src/ */\n`+
  `const __gsCoreModule={exports:{}};\n(function(module,exports,require){\n${core}\n})(__gsCoreModule,__gsCoreModule.exports,require);\n`+
  plugin.replace("require('./core.js')",'__gsCoreModule.exports');
if(!built.includes('module.exports.default=GuardedSyncPlugin;'))throw Error('Missing Obsidian plugin export');
await writeFile(join(dir,'main.js'),built,'utf8');
console.log(`Built main.js from sources (${built.length} chars) for ${m.id}@${m.version}`);
