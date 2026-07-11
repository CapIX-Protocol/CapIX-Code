const runtime = await import('@capix/runtime-provider');
if (typeof runtime.capix !== 'function') {
  throw new Error('@capix/runtime-provider does not export the capix provider factory');
}
const model = runtime.capix('auto');
if (model.specificationVersion !== 'v2' || model.provider !== 'capix') {
  throw new Error('@capix/runtime-provider does not implement the pinned LanguageModelV2 contract');
}
console.log('@capix/runtime-provider: bundled provider contract verified');
