import { ProviderError } from "./types.js";
/** Strict providers require an object root, even for a discriminated union.
 * Keep all branches/definitions intact under an explicit response envelope. */
export function objectEnvelope(schema: unknown) {
  const s = schema as Record<string, unknown>;
  if (s?.type === "object" && !s.anyOf && !s.oneOf) return { schema, wrapped: false };
  if (!s || typeof s !== "object") throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Structured schema is missing");
  const { $defs, ...body } = s;
  return { wrapped: true, schema: { type: "object", properties: { response: body }, required: ["response"], additionalProperties: false, ...($defs ? { $defs } : {}) } };
}
export function validateProviderSchema(schema: unknown, strict = true) {
  const root = schema as Record<string, unknown>;
  const fail = (at: string, reason: string): never => { throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${at}: ${reason}; request not submitted`); };
  if (!root || root.type !== "object" || root.anyOf || root.oneOf) fail("$", "structured output requires an object root (wrap root unions)");
  const visit = (value: unknown, at: string): void => {
    if (Array.isArray(value)) { value.forEach((v,i) => visit(v, `${at}/${i}`)); return; }
    if (!value || typeof value !== "object") return;
    const s = value as Record<string, unknown>;
    for (const key of ["allOf","not","if","then","else","dependentRequired","dependentSchemas","patternProperties","unevaluatedProperties"])
      if (key in s) fail(at,"unsupported strict-provider keyword " + key);
    if (s.$ref && (typeof s.$ref !== "string" || !s.$ref.startsWith("#/"))) fail(at, "only local schema references are supported");
    if (typeof s.$ref === "string") {
      let target: unknown = root;
      for (const key of s.$ref.slice(2).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g,"~"))) target = target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
      if (!target) fail(at, "unresolved schema reference " + s.$ref);
    }
    if (s.type === "object") {
      const properties = s.properties as Record<string, unknown> | undefined;
      const required = s.required as unknown[] | undefined;
      if (!properties || !Array.isArray(required) || required.some(k => typeof k !== "string" || !(k in properties))) fail(at, "invalid object properties/required");
      if (strict && (s.additionalProperties !== false || Object.keys(properties!).some(k => !required!.includes(k)))) fail(at, "strict objects must require every property and disallow additional properties");
    }
    for (const key of ["properties","$defs"]) {
      const entries = s[key];
      if (entries && typeof entries === "object") for (const [name,child] of Object.entries(entries)) visit(child,`${at}/${key}/${name}`);
    }
    for (const key of ["anyOf","oneOf","items","additionalProperties"]) if (s[key] && typeof s[key] === "object") visit(s[key],`${at}/${key}`);
  };
  visit(root, "$");
}
/** Lossless wire factoring of identical schema subtrees. Runtime validation stays unchanged. */
export function compactProviderSchema(schema:unknown):unknown {
 const counts=new Map<string,{count:number;value:Record<string,unknown>}>();
 const candidate=(v:Record<string,unknown>)=>!v.$ref&&(typeof v.type==='string'||Array.isArray(v.anyOf))&&JSON.stringify(v).length>=20;
 const scan=(v:unknown):void=>{if(Array.isArray(v)){v.forEach(scan);return;}if(!v||typeof v!=='object')return;const node=v as Record<string,unknown>;if(candidate(node)){const key=JSON.stringify(node),row=counts.get(key);counts.set(key,{count:(row?.count??0)+1,value:node});}Object.values(node).forEach(scan);};scan(schema);
 const definitions=new Map<string,{name:string;value:Record<string,unknown>}>();let index=0;const existing=(schema as {$defs?:Record<string,unknown>}).$defs??{};
 for(const [key,row]of counts)if(row.count>1){let name:string;do{name='w'+index++;}while(name in existing);if(row.count*(key.length-JSON.stringify({$ref:'#/$defs/'+name}).length)<=key.length+name.length+6)continue;definitions.set(key,{name,value:row.value});}
 if(!definitions.size)return schema;
 const rewrite=(v:unknown,skip?:string):unknown=>{if(Array.isArray(v))return v.map(x=>rewrite(x));if(!v||typeof v!=='object')return v;const key=JSON.stringify(v),d=definitions.get(key);if(d&&key!==skip)return {$ref:'#/$defs/'+d.name};return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)]));};
 const result=rewrite(schema) as Record<string,unknown>;
 result.$defs={...result.$defs as object,...Object.fromEntries([...definitions].map(([key,d])=>[d.name,rewrite(d.value,key)]))};
 return JSON.stringify(result).length<JSON.stringify(schema).length?result:schema;
}
