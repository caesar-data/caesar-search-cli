// Mozilla Readability's source is imported as raw text (bun's `type: "text"`
// loader) and injected into the page at render time, not used as a JS module.
// Type the subpath import as a string so the type checker is happy.
declare module "@mozilla/readability/Readability.js" {
  const source: string;
  export default source;
}
