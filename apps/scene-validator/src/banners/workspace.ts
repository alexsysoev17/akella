import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
let candidate=path.dirname(fileURLToPath(import.meta.url));
while(!existsSync(path.join(candidate,'scripts/knowledge/brand_library.py'))){const parent=path.dirname(candidate);if(parent===candidate)throw Error('AKELLA workspace not found');candidate=parent;}
export const workspace=candidate;
