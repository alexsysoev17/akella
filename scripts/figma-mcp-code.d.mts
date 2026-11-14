export function frameExportCode(origin: {fileKey:string;pageId:string;sectionId:string}, frameId:string, offset?:number, capturedAt?:string):Promise<string>;
export function discoveryCode(origin: {fileKey:string;pageId:string;sectionId:string}):string;
export function previewSignatureCode(pageId:string,frameId:string):Promise<string>;
