import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {documentForRecord} from '../dist/server/documents.js';
import {createTemplateSections,documentFields} from '../dist/contracts/inspection-template.js';
const payload={documentFields:Object.fromEntries(documentFields.map(f=>[f.key,'TESTE '+f.key])),documentImages:{},sections:createTemplateSections()};
for(const section of payload.sections)for(const item of section.items)item.situation='A';
const pdf=await documentForRecord({id:'docker-smoke',kind:'inspections',number:'TESTE',status:'draft',payload},'pdf','/app/storage');
assert.equal(pdf.subarray(0,4).toString(),'%PDF');
console.log('Docker: conversão real LibreOffice OK,',pdf.length,'bytes.');
