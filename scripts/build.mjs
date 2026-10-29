import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
for (const name of ['rules.mjs','stats.mjs']) await cp(new URL('public/' + name,root),new URL('cloudfunctions/scorekeeper/' + name,root));
await rm(new URL('dist/',root),{recursive:true,force:true});
await mkdir(new URL('dist/',root),{recursive:true});
await cp(new URL('public/',root),new URL('dist/',root),{recursive:true});
const names=(await readdir(new URL('dist/',root))).sort();
const hash=createHash('sha256');
for(const name of names) hash.update(await readFile(new URL('dist/'+name,root)));
const version=hash.digest('hex').slice(0,12);
for(const name of names.filter(n=>n.endsWith('.mjs'))) {
  const url=new URL('dist/'+name,root);
  const source=await readFile(url,'utf8');
  await writeFile(url,source.replace(/(['"])(\.\/[^'"?]+\.mjs)\1/g,(_,q,path)=>`${q}${path}?v=${version}${q}`));
}
const htmlURL=new URL('dist/index.html',root);
const html=await readFile(htmlURL,'utf8');
await writeFile(htmlURL,html.replace(/(src|href)="(\.\/(?:app\.mjs|config\.js|styles\.css))"/g,(_,attr,path)=>`${attr}="${path}?v=${version}"`));
console.log(`Built dist/ (${version}) and synchronized cloud function modules.`);
