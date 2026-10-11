import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
for(const sibling of process.argv.slice(2).length?process.argv.slice(2):['../stg-system-v2','../stg-inspector-mobile']){
 const target=path.resolve(sibling,'src/contracts');
 await fs.mkdir(target,{recursive:true});
 for(const file of ['domain.ts','types.ts','inspection-template.ts','inspection-template-cleanup.ts'])await fs.copyFile(path.join(root,'contracts',file),path.join(target,file));
 console.log('Contratos atualizados:',target);
}
