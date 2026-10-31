import { Compile } from "typebox/compile";

export type StructuredResult = { valid: boolean; value?: unknown; errors: string[] };
export type OutputSchema = Record<string, unknown> | boolean;

const schemaRef = {$ref:"#/$defs/schema"};
const nonnegativeInteger = {type:"integer",minimum:0};
const schemaArray = {type:"array",items:schemaRef,minItems:1};
const stringArray = {type:"array",items:{type:"string"},uniqueItems:true};
const types = {enum:["object","array","string","number","integer","boolean","null"]};
// Supported portable JSON Schema keywords. Reject unsupported contracts rather than silently ignoring them.
const contractValidator = Compile({$ref:"#/$defs/schema",$defs:{schema:{anyOf:[{type:"boolean"},{
 type:"object",additionalProperties:false,properties:{
  type:{anyOf:[types,{type:"array",items:types,minItems:1,uniqueItems:true}]},
  title:{type:"string"},description:{type:"string"},default:{},examples:{type:"array"},
  properties:{type:"object",additionalProperties:schemaRef},additionalProperties:schemaRef,
  required:stringArray,items:schemaRef,prefixItems:schemaArray,
  enum:{type:"array",minItems:1,uniqueItems:true},const:{},
  anyOf:schemaArray,allOf:schemaArray,oneOf:schemaArray,not:schemaRef,
  minimum:{type:"number"},maximum:{type:"number"},exclusiveMinimum:{type:"number"},exclusiveMaximum:{type:"number"},multipleOf:{type:"number",exclusiveMinimum:0},
  minLength:nonnegativeInteger,maxLength:nonnegativeInteger,pattern:{type:"string"},
  minItems:nonnegativeInteger,maxItems:nonnegativeInteger,uniqueItems:{type:"boolean"},
  minProperties:nonnegativeInteger,maxProperties:nonnegativeInteger,
 }
}]}}} as any);

/** Compile before dispatch so invalid contracts never start work. */
export function compileOutputSchema(schema: OutputSchema) {
 if(!contractValidator.Check(schema))throw new Error("Invalid or unsupported outputSchema: "+[...contractValidator.Errors(schema)].map(error=>`${error.instancePath || "/"}: ${error.message}`).join("; "));
 const validator = Compile(schema as any);
 return (text: string): StructuredResult => {
  let value: unknown;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim());
  try { value = JSON.parse(fenced ? fenced[1] : text); }
  catch { return {valid:false,errors:["Final response must be one JSON value matching outputSchema"]}; }
  if (validator.Check(value)) return {valid:true,value,errors:[]};
  return {valid:false,errors:[...validator.Errors(value)].map(error => `${error.instancePath || "/"}: ${error.message}`)};
 };
}
export function outputSchemaInstruction(schema: OutputSchema): string {
 return `\n[Output contract]\nFinish with one JSON value matching this JSON Schema: ${JSON.stringify(schema)}\nInclude actual evidence and unresolved work when requested by the schema. Never claim unchecked work is complete. No prose outside JSON. An invalid result is reported as failure; actions are never replayed to repair formatting.`;
}
